/**
 * SDK 中间件编排
 *
 * 根据账户配置组装 SDK 内置中间件链。
 * 中间件负责过滤和上下文富化；concurrencyGuard 负责串行+合并，
 * 合并后的消息继续走完剩余中间件链，最终统一由 bot.on("message") 处理转发。
 */
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import {
  messageFilter,
  contentSanitizer,
  rateLimiter,
  concurrencyGuard,
  mentionGate,
  quoteRef,
  historyBuffer,
  envelopeFormatter,
  typingIndicator,
  slashCommand,
  errorHandler,
} from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import { buildCommandList } from '../commands/index.js';
import { attachmentProcessor } from '../middleware/attachment.js';
import { assembleBody } from '../dispatch/body-assembler.js';
import { getPersistedRefIndexStore } from '../features/ref-index-store.js';
import { createPolicyInjector } from '../middleware/policy-injector.js';
import { getHistoryStore } from '../features/history-store.js';
import { dynamicAccessControl } from '../middleware/access-control.js';

export interface MiddlewareSetupOptions {
  /** 获取 runtime */
  getRuntime: () => any;
}

/**
 * 为 QQBot 实例编排完整的中间件链
 */
export function setupMiddlewares(bot: QQBot, account: ResolvedQQBotAccount, opts: MiddlewareSetupOptions): void {
  // 1. 错误兜底（最外层洋葱皮）
  bot.use(errorHandler());

  // 2. 消息过滤：bot 回声 + 消息去重
  bot.use(messageFilter({ skipSelfEcho: false }));

  // 3. 动态策略注入 — 每条消息注入 ctx.state.policy
  //    后续 dynamicAccessControl / mentionGate / historyBuffer 自动读取
  bot.use(createPolicyInjector(account));

  // 4. 动态访问控制 — 从 ctx.state.policy 动态读取，支持 pairing
  bot.use(dynamicAccessControl({
    accountId: account.accountId,
    getRuntime: opts.getRuntime,
  }));

  // 5. 群聊 @bot 门控（从 ctx.state.policy.group 读取动态配置）
  bot.use(mentionGate());

  // 6. 内容清洗（去 @marker、表情标签、多余空白）
  bot.use(contentSanitizer({ parseFaceTags: true }));

  // 7. 三层限流（sender / group / global）
  bot.use(rateLimiter());

  // 8. 并发串行+合并（在副作用中间件之前）
  //     - 同 peer 串行处理，避免平台 session conflict
  //     - 处理中消息暂存 buffer；完成后合并为一条，继续走完剩余中间件链
  //       （typingIndicator/quoteRef/historyBuffer/... 直到 bot.on("message")）
  //     - 合并时清除 assembledBody 让 dispatch.ts 用合并后 content 重建
  bot.use(concurrencyGuard({
    strategy: 'merge',
    maxQueue: 50,
    onMerge: (buffered) => {
      const last = buffered[buffered.length - 1];
      if (buffered.length === 1) return last;

      // 透传原始消息列表，格式拼接下沉给下游 envelopeFormatter / assembleBody
      (last.state as Record<string, unknown>).mergedMessages = buffered;

      // 合并附件（所有 buffer 中的附件汇总到 survivor）
      const attachments = buffered.flatMap((c) => c.message.attachments ?? []);
      if (attachments.length > 0) {
        last.message.attachments = attachments;
      }

      // 清除 assembledBody，让 dispatch.ts 用合并后的 ctx 重新构建
      delete (last.state as Record<string, unknown>).assembledBody;

      return last;
    },
  }));

  // 9. C2C 输入状态指示器
  bot.use(typingIndicator());

  // 10. 引用消息解析（注入持久化 store，进程重启后引用上下文不丢失）
  bot.use(quoteRef({
    store: getPersistedRefIndexStore(account.accountId),
  }));

  // 11. 群历史缓冲（limit 从 ctx.state.policy.group.historyLimit 读取）
  bot.use(historyBuffer({ store: getHistoryStore() }));

  // 12. 附件处理（语音 STT 转录 + 图片/文件下载）
  bot.use(attachmentProcessor({ getRuntime: opts.getRuntime }));

  // 13. 上下文组装（构建框架规约的 body）
  bot.use(envelopeFormatter({
    format: (ctx) => {
      const assembled = assembleBody(ctx, ctx.message as never, account, opts.getRuntime);
      (ctx.state as Record<string, unknown>).assembledBody = assembled;
      return assembled.agentBody;
    },
  }));

  // 14. 斜杠命令（命令被匹配后直接回复，不再向下传递）
  const slash = slashCommand({ commands: buildCommandList(account, { getRuntime: opts.getRuntime }) });
  bot.use(slash.middleware);
}
