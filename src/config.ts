import type { ResolvedQQBotAccount, QQBotAccountConfig, ToolPolicy, GroupConfig, GroupPrompts } from "./types.js";
import type { OpenClawConfig, GroupPolicy } from "openclaw/plugin-sdk";

export const DEFAULT_ACCOUNT_ID = "default";

// ------------------------------------------------------------
// 内联 evaluateMatchedGroupAccessForPolicy
// 源自 openclaw/src/plugin-sdk/group-access.ts
// 当前 openclaw dist 尚未包含此导出，本地实现避免运行时报错
// ------------------------------------------------------------

type MatchedGroupAccessReason = "allowed" | "disabled" | "missing_match_input" | "empty_allowlist" | "not_allowlisted";

interface MatchedGroupAccessDecision {
  allowed: boolean;
  groupPolicy: GroupPolicy;
  reason: MatchedGroupAccessReason;
}

function evaluateMatchedGroupAccessForPolicy(params: {
  groupPolicy: GroupPolicy;
  allowlistConfigured: boolean;
  allowlistMatched: boolean;
  requireMatchInput?: boolean;
  hasMatchInput?: boolean;
}): MatchedGroupAccessDecision {
  if (params.groupPolicy === "disabled") {
    return { allowed: false, groupPolicy: params.groupPolicy, reason: "disabled" };
  }
  if (params.groupPolicy === "allowlist") {
    if (params.requireMatchInput && !params.hasMatchInput) {
      return { allowed: false, groupPolicy: params.groupPolicy, reason: "missing_match_input" };
    }
    if (!params.allowlistConfigured) {
      return { allowed: false, groupPolicy: params.groupPolicy, reason: "empty_allowlist" };
    }
    if (!params.allowlistMatched) {
      return { allowed: false, groupPolicy: params.groupPolicy, reason: "not_allowlisted" };
    }
  }
  return { allowed: true, groupPolicy: params.groupPolicy, reason: "allowed" };
}

interface QQBotChannelConfig extends QQBotAccountConfig {
  accounts?: Record<string, QQBotAccountConfig>;
}

// ============ 群消息策略解析 ============

/** 默认群消息策略：接收所有群消息并回复 */
const DEFAULT_GROUP_POLICY: GroupPolicy = "open";

/** 默认群配置 */
const DEFAULT_GROUP_CONFIG: Required<GroupConfig> = {
  requireMention: false,
  toolPolicy: "restricted",
  name: "",
  prompts: undefined as unknown as GroupPrompts,
};

/** 默认群消息行为 PE（硬编码 fallback，可通过配置文件覆盖） */
const DEFAULT_GROUP_PROMPTS: Required<GroupPrompts> = {
  botMessage: [
    "若发送者为机器人，仅在对方明确@你提问或请求协助具体任务时，以简洁明了的内容回复，",
    "避免与其他机器人产生抢答或多轮无意义对话。",
    "在群聊中优先让人类用户的消息得到响应，机器人之间保持协作而非竞争，确保对话有序不刷屏。",
  ].join(""),
  mentioned: [
    "若发送者为机器人，仅在对方明确@你提问或请求协助具体任务时，以简洁明了的内容回复，",
    "避免与其他机器人产生抢答或多轮无意义对话。",
    "在群聊中优先让人类用户的消息得到响应，机器人之间保持协作而非竞争，确保对话有序不刷屏。",
  ].join(""),
  unmentioned: [
    "若发送者为机器人，仅在对方明确@你提问或请求协助具体任务时，以简洁明了的内容回复，",
    "避免与其他机器人产生抢答或多轮无意义对话。",
    "在群聊中优先让人类用户的消息得到响应，机器人之间保持协作而非竞争，确保对话有序不刷屏。",
  ].join(""),
};

/**
 * 解析群消息策略
 */
export function resolveGroupPolicy(cfg: OpenClawConfig, accountId?: string): GroupPolicy {
  const account = resolveQQBotAccount(cfg, accountId);
  return account.config?.groupPolicy ?? DEFAULT_GROUP_POLICY;
}

/**
 * 解析群白名单
 */
export function resolveGroupAllowFrom(cfg: OpenClawConfig, accountId?: string): string[] {
  const account = resolveQQBotAccount(cfg, accountId);
  return (account.config?.groupAllowFrom ?? []).map((id) => String(id).trim().toUpperCase());
}

/**
 * 检查指定群是否被允许（根据 groupPolicy + groupAllowFrom）
 *
 * 使用核心框架的 evaluateMatchedGroupAccessForPolicy 标准策略引擎，
 * 与 Telegram、Line、Nextcloud Talk 等渠道保持一致。
 *
 * 策略逻辑：
 * - "open": 允许所有群
 * - "disabled": 拒绝所有群
 * - "allowlist": 仅允许 groupAllowFrom 中配置的群（支持通配符 "*"）
 */
export function isGroupAllowed(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): boolean {
  const policy = resolveGroupPolicy(cfg, accountId);
  const allowList = resolveGroupAllowFrom(cfg, accountId);
  const allowlistConfigured = allowList.length > 0;
  const allowlistMatched = allowList.some((id) => id === "*" || id === groupOpenid.toUpperCase());

  return evaluateMatchedGroupAccessForPolicy({
    groupPolicy: policy,
    allowlistConfigured,
    allowlistMatched,
  }).allowed;
}

/**
 * resolveGroupConfig 的返回类型（prompts 保持可选，由 resolveGroupPrompts 独立解析）
 */
type ResolvedGroupConfig = Omit<Required<GroupConfig>, "prompts"> & Pick<GroupConfig, "prompts">;

/**
 * 解析指定群的配置（按优先级合并：具体 groupOpenid > 通配符 "*" > 默认值）
 */
export function resolveGroupConfig(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): ResolvedGroupConfig {
  const account = resolveQQBotAccount(cfg, accountId);
  const groups = account.config?.groups ?? {};

  const wildcardCfg = groups["*"] ?? {};
  const specificCfg = groups[groupOpenid] ?? {};

  return {
    requireMention: specificCfg.requireMention ?? wildcardCfg.requireMention ?? DEFAULT_GROUP_CONFIG.requireMention,
    toolPolicy: specificCfg.toolPolicy ?? wildcardCfg.toolPolicy ?? DEFAULT_GROUP_CONFIG.toolPolicy,
    name: specificCfg.name ?? wildcardCfg.name ?? DEFAULT_GROUP_CONFIG.name,
    prompts: specificCfg.prompts ?? wildcardCfg.prompts,
  };
}

/**
 * 解析指定群的行为 PE（按优先级合并：具体群 > 通配符 "*" > 默认内置值）
 *
 * 每个场景的 prompt 独立解析，支持部分覆盖：
 * 例如只配置 botMessage，其余字段自动 fallback 到默认值。
 */
export function resolveGroupPrompts(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): Required<GroupPrompts> {
  const account = resolveQQBotAccount(cfg, accountId);
  const groups = account.config?.groups ?? {};

  const wildcardPrompts = groups["*"]?.prompts ?? {};
  const specificPrompts = groups[groupOpenid]?.prompts ?? {};

  return {
    botMessage: specificPrompts.botMessage ?? wildcardPrompts.botMessage ?? DEFAULT_GROUP_PROMPTS.botMessage,
    mentioned: specificPrompts.mentioned ?? wildcardPrompts.mentioned ?? DEFAULT_GROUP_PROMPTS.mentioned,
    unmentioned: specificPrompts.unmentioned ?? wildcardPrompts.unmentioned ?? DEFAULT_GROUP_PROMPTS.unmentioned,
  };
}

/**
 * 解析指定群是否需要 @机器人才响应
 */
export function resolveRequireMention(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): boolean {
  return resolveGroupConfig(cfg, groupOpenid, accountId).requireMention;
}

/**
 * 解析指定群的工具策略
 */
export function resolveToolPolicy(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): ToolPolicy {
  return resolveGroupConfig(cfg, groupOpenid, accountId).toolPolicy;
}

/**
 * 解析群名称（传输层关注点）
 *
 * 与 Discord 取 displayChannelSlug → "#channel-name" 同理，
 * 此函数负责将 QQ 群 openid 映射为人类可读的群名称。
 * 优先从 groups config 中读取手动配置的名称，fallback 为 openid 前 8 位。
 *
 * 此函数由 gateway.ts 直接调用填充 GroupSubject 字段，
 * 而非通过 ChannelGroupAdapter 接口（框架不定义群名称解析标准方法）。
 */
export function resolveGroupName(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): string {
  const name = resolveGroupConfig(cfg, groupOpenid, accountId).name;
  return name || groupOpenid.slice(0, 8);
}

function normalizeAppId(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw).trim();
}

/**
 * 列出所有 QQBot 账户 ID
 */
export function listQQBotAccountIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;

  if (qqbot?.appId) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  if (qqbot?.accounts) {
    for (const accountId of Object.keys(qqbot.accounts)) {
      if (qqbot.accounts[accountId]?.appId) {
        ids.add(accountId);
      }
    }
  }

  return Array.from(ids);
}

/**
 * 获取默认账户 ID
 */
export function resolveDefaultQQBotAccountId(cfg: OpenClawConfig): string {
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;
  // 如果有默认账户配置，返回 default
  if (qqbot?.appId) {
    return DEFAULT_ACCOUNT_ID;
  }
  // 否则返回第一个配置的账户
  if (qqbot?.accounts) {
    const ids = Object.keys(qqbot.accounts);
    if (ids.length > 0) {
      return ids[0];
    }
  }
  return DEFAULT_ACCOUNT_ID;
}

/**
 * 解析 QQBot 账户配置
 */
export function resolveQQBotAccount(
  cfg: OpenClawConfig,
  accountId?: string | null
): ResolvedQQBotAccount {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;

  // 基础配置
  let accountConfig: QQBotAccountConfig = {};
  let appId = "";
  let clientSecret = "";
  let secretSource: "config" | "file" | "env" | "none" = "none";

  if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    // 默认账户从顶层读取
    accountConfig = {
      enabled: qqbot?.enabled,
      name: qqbot?.name,
      appId: qqbot?.appId,
      clientSecret: qqbot?.clientSecret,
      clientSecretFile: qqbot?.clientSecretFile,
      dmPolicy: qqbot?.dmPolicy,
      allowFrom: qqbot?.allowFrom,
      groupPolicy: qqbot?.groupPolicy,
      groupAllowFrom: qqbot?.groupAllowFrom,
      groups: qqbot?.groups,
      systemPrompt: qqbot?.systemPrompt,
      imageServerBaseUrl: qqbot?.imageServerBaseUrl,
      markdownSupport: qqbot?.markdownSupport ?? true,
      env: qqbot?.env,
      apiBase: qqbot?.apiBase,
      tokenUrl: qqbot?.tokenUrl,
    };
    appId = normalizeAppId(qqbot?.appId);
  } else {
    // 命名账户从 accounts 读取
    const account = qqbot?.accounts?.[resolvedAccountId];
    accountConfig = account ?? {};
    appId = normalizeAppId(account?.appId);
  }

  // 解析 clientSecret
  if (accountConfig.clientSecret) {
    clientSecret = accountConfig.clientSecret;
    secretSource = "config";
  } else if (accountConfig.clientSecretFile) {
    // 从文件读取（运行时处理）
    secretSource = "file";
  } else if (process.env.QQBOT_CLIENT_SECRET && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    clientSecret = process.env.QQBOT_CLIENT_SECRET;
    secretSource = "env";
  }

  // AppId 也可以从环境变量读取
  if (!appId && process.env.QQBOT_APP_ID && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    appId = normalizeAppId(process.env.QQBOT_APP_ID);
  }

  return {
    accountId: resolvedAccountId,
    name: accountConfig.name,
    enabled: accountConfig.enabled !== false,
    appId,
    clientSecret,
    secretSource,
    systemPrompt: accountConfig.systemPrompt,
    imageServerBaseUrl: accountConfig.imageServerBaseUrl || process.env.QQBOT_IMAGE_SERVER_BASE_URL,
    markdownSupport: accountConfig.markdownSupport !== false,
    env: (accountConfig.env || process.env.QQBOT_ENV || "production") as "test" | "production",
    apiBase: accountConfig.apiBase || process.env.QQBOT_API_BASE,
    tokenUrl: accountConfig.tokenUrl || process.env.QQBOT_TOKEN_URL,
    config: accountConfig,
  };
}

/**
 * 应用账户配置
 */
export function applyQQBotAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
  input: { appId?: string; clientSecret?: string; clientSecretFile?: string; name?: string; imageServerBaseUrl?: string }
): OpenClawConfig {
  const next = { ...cfg };

  if (accountId === DEFAULT_ACCOUNT_ID) {
    // 如果没有设置过 allowFrom，默认设置为 ["*"]
    const existingConfig = (next.channels?.qqbot as QQBotChannelConfig) || {};
    const allowFrom = existingConfig.allowFrom ?? ["*"];
    
    next.channels = {
      ...next.channels,
      qqbot: {
        ...(next.channels?.qqbot as Record<string, unknown> || {}),
        enabled: true,
        allowFrom,
        ...(input.appId ? { appId: input.appId } : {}),
        ...(input.clientSecret
          ? { clientSecret: input.clientSecret }
          : input.clientSecretFile
            ? { clientSecretFile: input.clientSecretFile }
            : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.imageServerBaseUrl ? { imageServerBaseUrl: input.imageServerBaseUrl } : {}),
      },
    };
  } else {
    // 如果没有设置过 allowFrom，默认设置为 ["*"]
    const existingAccountConfig = (next.channels?.qqbot as QQBotChannelConfig)?.accounts?.[accountId] || {};
    const allowFrom = existingAccountConfig.allowFrom ?? ["*"];
    
    next.channels = {
      ...next.channels,
      qqbot: {
        ...(next.channels?.qqbot as Record<string, unknown> || {}),
        enabled: true,
        accounts: {
          ...((next.channels?.qqbot as QQBotChannelConfig)?.accounts || {}),
          [accountId]: {
            ...((next.channels?.qqbot as QQBotChannelConfig)?.accounts?.[accountId] || {}),
            enabled: true,
            allowFrom,
            ...(input.appId ? { appId: input.appId } : {}),
            ...(input.clientSecret
              ? { clientSecret: input.clientSecret }
              : input.clientSecretFile
                ? { clientSecretFile: input.clientSecretFile }
                : {}),
            ...(input.name ? { name: input.name } : {}),
            ...(input.imageServerBaseUrl ? { imageServerBaseUrl: input.imageServerBaseUrl } : {}),
          },
        },
      },
    };
  }

  return next;
}
