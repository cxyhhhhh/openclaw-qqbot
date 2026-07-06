import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';
import { getQQBotDataDir } from '../utils/platform.js';
import { checkCommandAuth } from './config-util.js';

/** /bot-clear-storage — 清理通过QQBot对话产生的文件以及下载的资源 */
export function botClearStorage(account: ResolvedQQBotAccount): SlashCommand {
  return {
    name: 'bot-clear-storage',
    description: '清理通过QQBot对话产生的文件以及下载的资源（保存在 OpenClaw 运行环境的主机上）',
    scope: 'c2c',
    authorized: checkCommandAuth,
    usage: `/bot-clear-storage

清理 OpenClaw 运行环境中与当前账户相关的本地缓存文件，
包括会话文件、已知用户数据、引用索引等。`,
    handler: () => {
      const dataDir = getQQBotDataDir(account.accountId);

      const targets = [
        { file: 'session.json', label: '会话持久化' },
        { file: 'known-users.json', label: '已知用户数据' },
        { file: 'ref-index.jsonl', label: '引用索引' },
      ];

      const results: string[] = [];
      let cleared = 0;

      for (const { file, label } of targets) {
        const filePath = path.join(dataDir, file);
        try {
          if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            const sizeKb = (stat.size / 1024).toFixed(1);
            fs.unlinkSync(filePath);
            results.push(`  ✅ ${label} (${file}, ${sizeKb}KB)`);
            cleared++;
          }
        } catch {
          results.push(`  ⚠️ ${label} (${file}) 删除失败`);
        }
      }

      if (cleared === 0) {
        return 'ℹ️ 无需清除，本地存储已为空。';
      }

      return [
        `🗑️ 已清除 ${cleared} 个文件：`,
        '',
        ...results,
        '',
        `📁 存储目录: ${dataDir}`,
      ].join('\n');
    },
  };
}
