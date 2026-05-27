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

/**
 * 为 QQBot 实例编排完整的中间件链
 */
export function setupMiddlewares(bot: QQBot, account: ResolvedQQBotAccount): void {
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

  // 4. 群聊 @bot 门控
  const defaultGroup = config.groups?.['*'];
  bot.use(mentionGate({
    requireMentionInGroup: defaultGroup?.requireMention ?? true,
  }));

  // 5. 内容清洗（去 @marker、表情标签、多余空白）
  bot.use(contentSanitizer());

  // 6. 三层限流（sender / group / global）
  bot.use(rateLimiter());

  // 7. 并发串行控制（同用户/群顺序处理）
  bot.use(concurrencyGuard());

  // 8. C2C 输入状态指示器
  bot.use(typingIndicator());

  // 9. 引用消息解析
  bot.use(quoteRef());

  // 10. 群历史缓冲
  bot.use(historyBuffer({
    limit: defaultGroup?.historyLimit ?? 50,
  }));

  // 11. 上下文组装（构建 LLM prompt 格式的 envelope）
  bot.use(envelopeFormatter());

  // 12. 斜杠命令（命令被匹配后直接回复，不再向下传递）
  const slash = slashCommand({ commands: buildCommandList(account) });
  bot.use(slash.middleware);
}
