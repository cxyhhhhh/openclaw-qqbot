/**
 * 斜杠命令注册表
 *
 * 通过 SDK 的 slashCommand 中间件统一注册所有内置命令。
 * 每个命令拆分为独立文件，此处仅编排。
 */
import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import { botHelp } from './bot-help.js';
import { botPing } from './bot-ping.js';
import { botVersion } from './bot-version.js';
import { botMe } from './bot-me.js';
import { botUpgrade } from './bot-upgrade.js';
import { botStreaming } from './bot-streaming.js';
import { botClearStorage } from './bot-clear-storage.js';

/**
 * 构建标准命令列表（匹配后直接回复，不进入 AI）
 */
export function buildCommandList(account: ResolvedQQBotAccount): SlashCommand[] {
  return [
    botHelp(account),
    botPing(),
    botVersion(account),
    botMe(),
    botUpgrade(account),
    botStreaming(account),
    botClearStorage(account),
  ];
}


