/**
 * 群配置解析
 *
 * 优先级链（与旧版一致）：
 *   具体群配置 groups.{groupId}
 *     → 通配符 groups["*"]
 *       → 账户级 defaultRequireMention
 *         → 硬编码默认值
 */
import type { ResolvedQQBotAccount, GroupConfig } from '../types.js';

const DEFAULT_REQUIRE_MENTION = true;
const DEFAULT_IGNORE_OTHER_MENTIONS = false;
const DEFAULT_HISTORY_LIMIT = 50;

export interface ResolvedGroupConfig {
  requireMention: boolean;
  ignoreOtherMentions: boolean;
  historyLimit: number;
  prompt?: string;
}

/**
 * 按优先级链解析指定群的配置
 */
export function resolveGroupConfig(account: ResolvedQQBotAccount, groupOpenid: string): ResolvedGroupConfig {
  const groups = account.config.groups ?? {};
  const wildcardCfg: GroupConfig = groups['*'] ?? {};
  const specificCfg: GroupConfig = groups[groupOpenid] ?? {};
  const accountDefaultRequireMention = account.config.defaultRequireMention ?? DEFAULT_REQUIRE_MENTION;

  return {
    requireMention: specificCfg.requireMention ?? wildcardCfg.requireMention ?? accountDefaultRequireMention,
    ignoreOtherMentions: specificCfg.ignoreOtherMentions ?? wildcardCfg.ignoreOtherMentions ?? DEFAULT_IGNORE_OTHER_MENTIONS,
    historyLimit: specificCfg.historyLimit ?? wildcardCfg.historyLimit ?? DEFAULT_HISTORY_LIMIT,
    prompt: specificCfg.prompt ?? wildcardCfg.prompt,
  };
}
