/**
 * Gateway 生命周期管理
 *
 * 封装 startAccount / logoutAccount 的业务逻辑：
 * - 凭证恢复
 * - QQBotGateway 实例创建与注册
 * - Features 初始化（image-server、update-checker、approval-handler）
 * - 登出时凭证清除
 */
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import type { ResolvedQQBotAccount } from '../types.js';
import { DEFAULT_ACCOUNT_ID, resolveQQBotAccount, applyQQBotAccountConfig } from '../config.js';
import { getQQBotRuntime } from '../runtime.js';
import { QQBotGateway, type GatewayLogSink } from './qqbot-gateway.js';
import { registerGateway, unregisterGateway } from '../outbound/outbound-service.js';
import { saveCredentialBackup, loadCredentialBackup } from '../features/credential-backup.js';
import { startImageServer, isImageServerRunning } from '../features/image-server.js';
import { triggerUpdateCheck } from '../features/update-checker.js';
import { QQBotApprovalHandler, registerApprovalHandler, unregisterApprovalHandler } from '../features/approval-handler.js';

export interface StartAccountContext {
  account: ResolvedQQBotAccount;
  abortSignal?: AbortSignal;
  cfg: any;
  log?: GatewayLogSink;
  getStatus: () => Record<string, unknown>;
  setStatus: (s: Record<string, unknown>) => void;
  [key: string]: unknown;
}

/**
 * 启动账户（含凭证恢复 + features 初始化）
 */
export async function startAccountWithCredentialRecovery(ctx: StartAccountContext): Promise<void> {
  let { account } = ctx;
  const { abortSignal, log, cfg } = ctx;
  const runtime = getQQBotRuntime();

  // 凭证恢复：配置中 appId/secret 为空时尝试从暂存文件恢复
  if (!account.appId || !account.clientSecret) {
    const backup = loadCredentialBackup(account.accountId);
    if (backup) {
      log?.info(`[qqbot:${account.accountId}] 从暂存文件恢复凭证 (appId=${backup.appId})`);
      try {
        const restoredCfg = applyQQBotAccountConfig(cfg, account.accountId, {
          appId: backup.appId,
          clientSecret: backup.clientSecret,
        });
        const configApi = runtime.config as { writeConfigFile: (cfg: unknown) => Promise<void> };
        await configApi.writeConfigFile(restoredCfg);
        account = resolveQQBotAccount(restoredCfg, account.accountId);
      } catch (e) {
        log?.error(`[qqbot:${account.accountId}] 凭证恢复失败: ${e}`);
      }
    }
  }

  // 创建 gateway 实例并注册
  const gw = new QQBotGateway(account, runtime, log);
  registerGateway(account.accountId, gw);

  await gw.start(
    {
      onReady: () => {
        log?.info(`[qqbot:${account.accountId}] Gateway ready`);
        saveCredentialBackup(account.accountId, account.appId, account.clientSecret);
        ctx.setStatus({
          ...ctx.getStatus(),
          running: true,
          connected: true,
          lastConnectedAt: Date.now(),
        });

        // ── Features 初始化（gateway ready 后触发）──
        initFeatures(account, cfg, log);
      },
      onError: (error) => {
        log?.error(`[qqbot:${account.accountId}] Gateway error: ${error.message}`);
        ctx.setStatus({ ...ctx.getStatus(), lastError: error.message });
      },
    },
    abortSignal,
  );
}

/**
 * Gateway ready 后初始化各 feature 模块
 */
function initFeatures(account: ResolvedQQBotAccount, cfg: any, log?: GatewayLogSink): void {
  // 1. 图片代理服务器（仅首次启动）
  if (account.imageServerBaseUrl && !isImageServerRunning()) {
    try {
      startImageServer({ baseUrl: account.imageServerBaseUrl });
      log?.info(`[qqbot:${account.accountId}] Image server started`);
    } catch (e) {
      log?.error(`[qqbot:${account.accountId}] Image server failed: ${e}`);
    }
  }

  // 2. 版本更新检测（后台预热，fire-and-forget）
  triggerUpdateCheck(log);

  // 3. 审批处理器（监听框架审批事件 → 发送 Inline Keyboard）
  try {
    const handler = new QQBotApprovalHandler({
      accountId: account.accountId,
      appId: account.appId,
      clientSecret: account.clientSecret,
      cfg,
      log,
    });
    registerApprovalHandler(account.accountId, handler);
    handler.start().catch((e) => {
      log?.error(`[qqbot:${account.accountId}] Approval handler start failed: ${e}`);
    });
    log?.info(`[qqbot:${account.accountId}] Approval handler registered`);
  } catch (e) {
    // 旧版框架无 gateway-runtime 时会抛出，降级为不可用
    log?.debug?.(`[qqbot:${account.accountId}] Approval handler not available: ${e}`);
  }
}

/**
 * 登出账户（清除凭证）
 */
export async function logoutAndClearCredentials(params: {
  accountId: string;
  cfg: any;
}): Promise<{ ok: boolean; cleared: boolean; envToken: boolean; loggedOut: boolean }> {
  const { accountId, cfg } = params;
  unregisterGateway(accountId);

  const nextCfg = { ...cfg } as OpenClawConfig;
  const nextQQBot = cfg.channels?.qqbot ? { ...cfg.channels.qqbot } : undefined;
  let cleared = false;
  let changed = false;

  if (nextQQBot) {
    const qqbot = nextQQBot as Record<string, unknown>;
    if (accountId === DEFAULT_ACCOUNT_ID && qqbot.clientSecret) {
      delete qqbot.clientSecret;
      cleared = true;
      changed = true;
    }
    const accounts = qqbot.accounts as Record<string, Record<string, unknown>> | undefined;
    if (accounts && accountId in accounts) {
      const entry = accounts[accountId];
      if (entry && 'clientSecret' in entry) {
        delete entry.clientSecret;
        cleared = true;
        changed = true;
      }
      if (entry && Object.keys(entry).length === 0) {
        delete accounts[accountId];
        changed = true;
      }
    }
  }

  if (changed && nextQQBot) {
    nextCfg.channels = { ...nextCfg.channels, qqbot: nextQQBot };
    const runtime = getQQBotRuntime();
    const configApi = runtime.config as { writeConfigFile: (cfg: OpenClawConfig) => Promise<void> };
    await configApi.writeConfigFile(nextCfg);
  }

  const resolved = resolveQQBotAccount(changed ? nextCfg : cfg, accountId);
  const loggedOut = resolved.secretSource === 'none';
  const envToken = Boolean(process.env.QQBOT_CLIENT_SECRET);
  return { ok: true, cleared, envToken, loggedOut };
}
