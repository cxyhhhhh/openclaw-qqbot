import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';

/** /bot-ping — 网络延迟测试 */
export function botPing(): SlashCommand {
  return {
    name: 'bot-ping',
    description: '网络延迟测试',
    handler: (ctx) => {
      const latency = Date.now() - ctx.receivedAt;
      return `🏓 Pong! 延迟: ${latency}ms`;
    },
  };
}
