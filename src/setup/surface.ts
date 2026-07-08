/**
 * OpenClaw setup 向导 — QQ Bot 配置界面
 */
import type { ChannelSetupWizard } from '../adapter/setup.js';
import { createStandardChannelSetupStatus, setSetupChannelEnabled } from '../adapter/setup.js';
import { listQQBotAccountIds, resolveQQBotAccount } from '../config.js';
import { finalizeQQBotSetup } from './finalize.js';

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
      (accountId ? [accountId] : listQQBotAccountIds(cfg as any)).some((id) => {
        const account = resolveQQBotAccount(cfg as any, id);
        return Boolean(account.appId && account.clientSecret);
      }),
  }),
  credentials: [],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  finalize: (async ({ cfg, accountId, prompter, runtime }: any) =>
    finalizeQQBotSetup({ cfg, accountId, prompter: prompter as any, runtime: runtime as any })) as any,
  disable: (cfg) => { setSetupChannelEnabled(cfg, CHANNEL, false); return cfg; },
};
