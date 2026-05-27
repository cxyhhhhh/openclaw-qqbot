import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import fs from 'node:fs';
import { getQQBotDataDir } from '../utils/platform.js';

/** /bot-clear-storage — 清除本地存储 */
export function botClearStorage(account: ResolvedQQBotAccount): SlashCommand {
  return {
    name: 'bot-clear-storage',
    description: '清除本地存储',
    handler: () => {
      const dataDir = getQQBotDataDir(account.accountId);
      let cleared = 0;

      const targets = ['session.json', 'known-users.json', 'ref-index.jsonl'];
      for (const file of targets) {
        const filePath = `${dataDir}/${file}`;
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            cleared++;
          }
        } catch {
          // 忽略删除失败
        }
      }

      return cleared > 0
        ? `🗑️ 已清除 ${cleared} 个本地存储文件（会话、缓存等）。`
        : 'ℹ️ 无需清除，本地存储已为空。';
    },
  };
}
