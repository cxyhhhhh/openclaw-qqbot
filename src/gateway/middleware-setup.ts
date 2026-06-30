/**
 * SDK 中间件编排
 *
 * 根据账户配置组装 SDK 内置中间件链。
 * 中间件仅负责过滤和上下文富化，业务转发在 bot.on("message") 事件中处理。
 */
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import {
  messageFilter,
  contentSanitizer,
  rateLimiter,
  concurrencyGuard,
  accessPolicy,
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
import { attachmentProcessor } from './attachment-middleware.js';
import { assembleBody } from '../dispatch/body-assembler.js';
import { getPersistedRefIndexStore } from '../features/ref-index-store.js';

export interface MiddlewareSetupOptions {
  /** 获取 runtime */
  getRuntime: () => any;
}

/**
 * 为 QQBot 实例编排完整的中间件链
 */
export function setupMiddlewares(bot: QQBot, account: ResolvedQQBotAccount, opts: MiddlewareSetupOptions): void {
  const config = account.config;

  // 1. 错误兜底（最外层洋葱皮）
  bot.use(errorHandler());

  // 2. 消息过滤：bot 回声 + 消息去重
  bot.use(messageFilter());

  // 3. 访问控制（黑白名单）
  if (config.allowFrom?.length) {
    bot.use(accessPolicy({
      c2c: { mode: 'allowlist', allow: config.allowFrom },
      group: { mode: 'allowlist', allow: config.allowFrom },
    }));
  }

  // 4. 群聊 @bot 门控（含 ignoreOtherMentions — @了其他人但未@bot 时直接丢弃）
  const defaultGroup = config.groups?.['*'];
  bot.use(mentionGate({
    requireMentionInGroup: defaultGroup?.requireMention ?? true,
    ignoreOtherMentions: defaultGroup?.ignoreOtherMentions ?? false,
  }));

  // 5. 内容清洗（去 @marker、表情标签、多余空白）
  bot.use(contentSanitizer());

  // 6. 三层限流（sender / group / global）
  bot.use(rateLimiter());

  // 7. 并发串行控制（同用户/群顺序处理）
  bot.use(concurrencyGuard());

  // 8. C2C 输入状态指示器
  bot.use(typingIndicator());

  // 9. 引用消息解析（注入持久化 store，进程重启后引用上下文不丢失）
  bot.use(quoteRef({
    store: getPersistedRefIndexStore(account.accountId),
  }));

  // 10. 群历史缓冲
  bot.use(historyBuffer({
    limit: defaultGroup?.historyLimit ?? 50,
  }));

  // 11. 附件处理（语音 STT 转录 + 图片/文件下载）
  bot.use(attachmentProcessor({ getRuntime: opts.getRuntime  }));

  // 12. 上下文组装（构建框架规约的 body）
  // 注入自定义 formatter，调用 assembleBody 完整组装并缓存到 ctx.state
  bot.use(envelopeFormatter({
    format: (ctx) => {
      const assembled = assembleBody(ctx, ctx.message as never, account);
      // 缓存完整组装结果，供 dispatch 阶段直接消费（避免重算）
      (ctx.state as Record<string, unknown>).assembledBody = assembled;
      // SDK 类型契约要求 envelope 是 string，返回 agentBody（AI 实际消费的字符串）
      return assembled.agentBody;
    },
  }));

  // 13. 斜杠命令（命令被匹配后直接回复，不再向下传递）
  const slash = slashCommand({ commands: buildCommandList(account, { getRuntime: opts.getRuntime }) });
  bot.use(slash.middleware);
}
