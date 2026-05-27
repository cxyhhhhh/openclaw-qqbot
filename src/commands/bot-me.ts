import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';

/** /bot-me — 查看发送者 OpenID（仅私聊） */
export function botMe(): SlashCommand {
  return {
    name: 'bot-me',
    description: '查看你的 OpenID（仅私聊）',
    scope: 'c2c',
    handler: (ctx) => {
      const senderId = ctx.message.senderId ?? 'unknown';
      return `🆔 你的 OpenID: \`${senderId}\``;
    },
  };
}
