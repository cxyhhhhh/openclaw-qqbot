import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';

/** /bot-help — 列出所有可用命令 */
export function botHelp(_account: ResolvedQQBotAccount): SlashCommand {
  return {
    name: 'bot-help',
    description: '列出所有可用命令',
    handler: () => {
      const lines = [
        '📋 **可用命令**',
        '',
        '`/bot-help` — 显示此帮助信息',
        '`/bot-ping` — 网络延迟测试',
        '`/bot-version` — 查看版本信息',
        '`/bot-me` — 查看你的 OpenID（仅私聊）',
        '`/bot-upgrade` — 插件升级',
        '`/bot-streaming` — 流式消息控制',
        '`/bot-clear-storage` — 清除本地存储',
      ];
      return lines.join('\n');
    },
  };
}
