import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';

/** /bot-streaming — 流式消息控制 */
export function botStreaming(account: ResolvedQQBotAccount): SlashCommand {
  return {
    name: 'bot-streaming',
    description: '流式消息控制',
    handler: () => {
      const enabled = account.config.streaming ?? false;
      const status = enabled ? '✅ 已启用' : '❌ 未启用';
      const lines = [
        '🌊 **流式消息状态**',
        '',
        `当前状态: ${status}`,
        '',
        '流式消息仅支持 C2C（私聊）场景。',
        '如需开关，请修改配置文件中 `channels.qqbot.streaming` 字段。',
      ];
      return lines.join('\n');
    },
  };
}
