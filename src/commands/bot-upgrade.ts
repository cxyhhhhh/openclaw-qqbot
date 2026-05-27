import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';

/** /bot-upgrade — 插件热升级 */
export function botUpgrade(account: ResolvedQQBotAccount): SlashCommand {
  return {
    name: 'bot-upgrade',
    description: '插件升级',
    handler: async () => {
      const config = account.config;
      const upgradeMode = config.upgradeMode ?? 'hot-reload';
      const upgradeUrl = config.upgradeUrl ??
        'https://doc.weixin.qq.com/doc/w3_AKEAGQaeACgCNHrh1CbHzTAKtT2gB?scode=AJEAIQdfAAozxFEnLZAKEAGQaeACg';

      if (upgradeMode === 'doc') {
        return `📖 升级文档：${upgradeUrl}`;
      }

      // hot-reload 模式
      const pkgName = config.upgradePkg ?? '@tencent-connect/openclaw-qqbot';
      return `🔄 正在检查更新 (${pkgName})...\n💡 热升级功能迁移中，请暂时使用命令行升级：\n\`npx openclaw upgrade qqbot\``;
    },
  };
}
