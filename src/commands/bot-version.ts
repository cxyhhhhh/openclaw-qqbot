import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';

/** /bot-version — 查看版本信息 */
export function botVersion(account: ResolvedQQBotAccount): SlashCommand {
  return {
    name: 'bot-version',
    description: '查看版本信息',
    handler: async (ctx) => {
      let pluginVersion = 'unknown';
      try {
        const pkg = await import('../../package.json', { assert: { type: 'json' } });
        pluginVersion = (pkg as any).default?.version ?? 'unknown';
      } catch {
        // fallback
      }

      const lines = [
        '📦 **版本信息**',
        '',
        `插件: @tencent-connect/openclaw-qqbot v${pluginVersion}`,
        `账户: ${account.accountId} (appId: ${account.appId})`,
        `Node.js: ${process.version}`,
        `平台: ${process.platform} ${process.arch}`,
      ];
      return lines.join('\n');
    },
  };
}
