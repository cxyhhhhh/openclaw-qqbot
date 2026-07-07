/**
 * OpenClaw setup 向导 — QQ Bot 配置界面
 */
import type { ChannelSetupWizard } from 'openclaw/plugin-sdk/setup';
import { createStandardChannelSetupStatus } from 'openclaw/plugin-sdk/setup';
import { listQQBotAccountIds, resolveQQBotAccount } from '../config.js';
import { finalizeQQBotSetup } from './finalize.js';
import { setSetupChannelEnabled } from 'openclaw/plugin-sdk/setup';

const CHANNEL = 'qqbot' as const;

export const qqbotSetupWizard: ChannelSetupWizard = {
  channel: CHANNEL,
  status: createStandardChannelSetupStatus({
    channelLabel: 'QQ Bot',
    configuredLabel: 'configured',
    unconfiguredLabel: 'needs AppID + AppSecret',
    configuredHint: 'configured',
    unconfiguredHint: 'needs AppID + AppSecret',
    configuredScore: 1,
    unconfiguredScore: 6,
    resolveConfigured: ({ cfg, accountId }) =>
      (accountId ? [accountId] : listQQBotAccountIds(cfg)).some((id) => {
        const account = resolveQQBotAccount(cfg, id);
        return Boolean(account.appId && account.clientSecret);
      }),
  }),
  credentials: [],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  finalize: (async ({ cfg, accountId, prompter, runtime }: any) =>
    finalizeQQBotSetup({ cfg, accountId, prompter: prompter as any, runtime: runtime as any })) as any,
  disable: (cfg) => setSetupChannelEnabled(cfg, CHANNEL, false),
};
