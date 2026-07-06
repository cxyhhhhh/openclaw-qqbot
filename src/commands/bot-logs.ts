import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getQQBotDataDir } from '../utils/platform.js';
import { checkCommandAuth } from './config-util.js';

const MAX_LINES_PER_FILE = 1000;
const MAX_FILES = 4;

interface LogFileEntry {
  filePath: string;
  sourceDir: string;
  mtime: number;
}

/** 收集候选日志目录 */
function collectCandidateLogDirs(): string[] {
  const home = os.homedir();
  const dirs = [
    path.join(home, '.openclaw', 'logs'),
    path.join(home, '.openclaw'),
  ];

  // PM2 日志目录
  const pm2Home = process.env.PM2_HOME ?? path.join(home, '.pm2');
  dirs.push(path.join(pm2Home, 'logs'));

  return dirs;
}

/** 从候选目录中收集最近的日志文件 */
function collectRecentLogFiles(dirs: string[]): LogFileEntry[] {
  const files: LogFileEntry[] = [];

  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (!entry.endsWith('.log') && !entry.endsWith('.txt')) continue;
        const filePath = path.join(dir, entry);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile() && stat.size > 0) {
            files.push({ filePath, sourceDir: dir, mtime: stat.mtimeMs });
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // 按修改时间降序
  return files.sort((a, b) => b.mtime - a.mtime);
}

/** /bot-logs — 导出本地日志文件 */
export function botLogs(): SlashCommand {
  return {
    name: 'bot-logs',
    description: '导出本地日志文件',
    scope: 'c2c',
    authorized: checkCommandAuth,
    usage: [
      '/bot-logs',
      '',
      `导出最近的 OpenClaw 日志文件（最多 ${MAX_FILES} 个）。`,
      `每个文件最多保留最后 ${MAX_LINES_PER_FILE} 行，以文件形式返回。`,
    ].join('\n'),
    handler: async (ctx) => {
      const logDirs = collectCandidateLogDirs();
      const recentFiles = collectRecentLogFiles(logDirs).slice(0, MAX_FILES);

      if (recentFiles.length === 0) {
        const existingDirs = logDirs.filter((d) => { try { return fs.existsSync(d); } catch { return false; } });
        const searched = existingDirs.length > 0
          ? existingDirs.map((d) => `  • ${d}`).join('\n')
          : logDirs.map((d) => `  • ${d}`).join('\n');
        return [
          '⚠️ 未找到日志文件',
          '',
          `已搜索以下${existingDirs.length > 0 ? '已存在的' : ''}路径：`,
          searched,
          '',
          '💡 如果日志在自定义路径，请在配置文件中添加：',
          '  "logging": { "file": "/path/to/your/logfile.log" }',
        ].join('\n');
      }

      const lines: string[] = [];
      let totalIncluded = 0;
      let totalOriginal = 0;
      let truncatedCount = 0;

      for (const logFile of recentFiles) {
        try {
          const content = fs.readFileSync(logFile.filePath, 'utf8');
          const allLines = content.split('\n');
          const totalFileLines = allLines.length;
          const tail = allLines.slice(-MAX_LINES_PER_FILE);
          if (tail.length > 0) {
            const fileName = path.basename(logFile.filePath);
            lines.push(`\n========== ${fileName} (last ${tail.length} of ${totalFileLines} lines) ==========`);
            lines.push(`from: ${logFile.sourceDir}`);
            lines.push(...tail);
            totalIncluded += tail.length;
            totalOriginal += totalFileLines;
            if (totalFileLines > MAX_LINES_PER_FILE) truncatedCount++;
          }
        } catch {
          lines.push(`[读取 ${path.basename(logFile.filePath)} 失败]`);
        }
      }

      if (lines.length === 0) {
        return '⚠️ 找到日志文件但读取失败，请检查文件权限';
      }

      // 写入临时文件
      const tmpDir = getQQBotDataDir('downloads');
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const tmpFile = path.join(tmpDir, `bot-logs-${timestamp}.txt`);
      fs.writeFileSync(tmpFile, lines.join('\n'), 'utf8');

      const fileCount = recentFiles.length;
      const topSources = Array.from(new Set(recentFiles.map((item) => item.sourceDir))).slice(0, 3);

      let summaryText = `${fileCount} 个日志文件，共 ${totalIncluded} 行`;
      if (truncatedCount > 0) {
        summaryText += `（${truncatedCount} 个文件因过长仅保留最后 ${MAX_LINES_PER_FILE} 行，原始共 ${totalOriginal} 行）`;
      }

      // 通过 bot SDK 直接发送文件（旧版在 gateway 层处理 { text, filePath }）
      try {
        const senderId = ctx.message.senderId;
        if (senderId) {
          await ctx.bot.sendFile(
            { scope: 'c2c', targetId: senderId, msgId: ctx.message.messageId },
            { localPath: tmpFile },
            { fileName: `bot-logs-${timestamp}.txt` },
          );
        }
      } catch (err) {
        return `📋 ${summaryText}\n📂 来源：${topSources.join(' | ')}\n\n⚠️ 文件发送失败：${err instanceof Error ? err.message : String(err)}\n📎 本地路径：${tmpFile}`;
      }

      return `📋 ${summaryText}\n📂 来源：${topSources.join(' | ')}`;
    },
  };
}
