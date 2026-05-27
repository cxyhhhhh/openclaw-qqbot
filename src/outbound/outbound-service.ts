/**
 * 出站消息服务
 *
 * 负责将 AI 回复通过 SDK 发送到 QQ。
 * 由 ChannelPlugin.outbound.sendText / sendMedia 调用。
 */
import type { QQBotGateway } from '../gateway/index.js';
import type { ResolvedQQBotAccount } from '../types.js';
import { parseTarget } from './target.js';

// ── Gateway 注册表（生命周期由 channel.ts 管理）──

const gateways = new Map<string, QQBotGateway>();

export function registerGateway(accountId: string, gw: QQBotGateway): void {
  gateways.set(accountId, gw);
}

export function unregisterGateway(accountId: string): void {
  gateways.delete(accountId);
}

export function getGateway(accountId: string): QQBotGateway | undefined {
  return gateways.get(accountId);
}

// ── 出站公开 API ──

export interface SendResult {
  messageId?: string;
  error?: string;
  errorCode?: string;
  qqBizCode?: number;
}

/**
 * ChannelPlugin.outbound.sendText 实现
 */
export async function sendText(params: {
  to: string;
  text: string;
  accountId?: string;
  replyToId?: string;
  account: ResolvedQQBotAccount;
}): Promise<SendResult> {
  const gw = gateways.get(params.account.accountId);
  if (!gw) {
    return { error: `Bot "${params.account.accountId}" not running` };
  }

  try {
    const target = parseTarget(params.to);
    const result = await gw.sendText(target, params.text, { msgId: params.replyToId });
    return { messageId: result.id };
  } catch (err: unknown) {
    return formatError(err);
  }
}

/**
 * ChannelPlugin.outbound.sendMedia 实现
 */
export async function sendMedia(params: {
  to: string;
  text?: string;
  mediaUrl: string;
  accountId?: string;
  replyToId?: string;
  account: ResolvedQQBotAccount;
}): Promise<SendResult> {
  const gw = gateways.get(params.account.accountId);
  if (!gw) {
    return { error: `Bot "${params.account.accountId}" not running` };
  }

  try {
    const target = parseTarget(params.to);
    const result = await gw.sendMedia(target, params.mediaUrl, {
      text: params.text,
      msgId: params.replyToId,
    });
    return { messageId: result.id };
  } catch (err: unknown) {
    return formatError(err);
  }
}

// ── 新增出站服务类（供 dispatch 层直接调用）──

export class OutboundService {
  constructor(private readonly gw: QQBotGateway) {}

  async sendText(to: string, text: string, msgId?: string): Promise<SendResult> {
    try {
      const target = parseTarget(to);
      const result = await this.gw.sendText(target, text, { msgId });
      return { messageId: result.id };
    } catch (err: unknown) {
      return formatError(err);
    }
  }

  async sendMedia(to: string, source: string, opts?: { text?: string; msgId?: string }): Promise<SendResult> {
    try {
      const target = parseTarget(to);
      const result = await this.gw.sendMedia(target, source, opts);
      return { messageId: result.id };
    } catch (err: unknown) {
      return formatError(err);
    }
  }
}

// ── 内部工具 ──

function formatError(err: unknown): SendResult {
  if (err instanceof Error) {
    const result: SendResult = { error: err.message };
    if ('code' in err) result.errorCode = String((err as any).code);
    if ('qqBizCode' in err) result.qqBizCode = (err as any).qqBizCode;
    return result;
  }
  return { error: String(err) };
}
