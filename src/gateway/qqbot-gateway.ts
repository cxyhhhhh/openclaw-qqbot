/**
 * QQBotGateway — 封装单个 Bot 实例的完整生命周期
 */
import {
  QQBot,
  FileKVStore,
  kvSessionPersistence,
  MediaFileType,
  type ReplyTarget,
  type QQBotInboundMessage,
  type MiddlewareContext,
  type InteractionEvent,
  type MessageResponse,
  type StreamSession,
} from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import { createPluginLogger } from '../utils/plugin-logger.js';
import { setupMiddlewares } from './middleware-setup.js';
import { handleMessage, handleInteraction } from './event-handlers.js';
import { getQQBotDataDir } from '../utils/platform.js';
import { buildUserAgent } from '../bot-instance.js';

export interface GatewayCallbacks {
  onReady?: () => void;
  onError?: (error: Error) => void;
}

export interface SendOptions {
  msgId?: string;
  text?: string;
}

export class QQBotGateway {
  readonly bot: QQBot;
  private readonly account: ResolvedQQBotAccount;
  private readonly runtime: PluginRuntime;
  readonly log: PluginLogger;

  constructor(account: ResolvedQQBotAccount, runtime: PluginRuntime, log?: PluginLogger) {
    this.account = account;
    this.runtime = runtime;
    this.log = log ?? createPluginLogger({ prefix: `[qqbot:${account.accountId}]` });

    const dataDir = getQQBotDataDir(account.accountId);

    this.bot = new QQBot({
      appId: account.appId,
      appSecret: account.clientSecret,
      accountId: account.accountId,
      markdownSupport: account.markdownSupport,
      userAgent: buildUserAgent(),
      sessionPersistence: kvSessionPersistence({
        store: new FileKVStore({ dir: dataDir, fileName: 'session.json' }),
        accountId: account.accountId,
      }),
      tokenPrefetch: 'sync',
      logger: this.log,
    });

    // concurrencyGuard 的 merge 策略合并后会继续走完剩余中间件链，
    // 最终与单条消息一样统一由下方 bot.on('message') 处理转发，
    // 因此这里不再需要单独的 onMergeDispatch 回调。
    setupMiddlewares(this.bot, account, {
      getRuntime: () => runtime,
    });
  }

  async start(callbacks?: GatewayCallbacks, signal?: AbortSignal): Promise<void> {
    const handleReady = () => {
      this.log.info(`Gateway ready`);
      callbacks?.onReady?.();
    };
    this.bot.on(`ready`, handleReady);
    this.bot.on(`resumed`, handleReady);


    this.bot.on('error', (err: Error) => {
      this.log.error(`Gateway error: ${err.message}`);
      callbacks?.onError?.(err);
    });

    const gatewayLog = this.log.child('gateway');

    this.bot.on('message', async (ctx: MiddlewareContext, msg: QQBotInboundMessage) => {
      gatewayLog.debug(`message msgId=${msg.messageId}`);
      try {
        await handleMessage(ctx, msg, this.account, this.runtime, this.log);
      } catch (err) {
        gatewayLog.error(`Dispatch error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    this.bot.on('interaction', (_ctx, event: InteractionEvent) => {
      handleInteraction(event, this.account, this.runtime, this.log, (id) =>
        this.bot.acknowledgeInteraction(id),
      ).catch((err) => {
        this.log.error(`Interaction error: ${err}`);
      });
    });

    await this.bot.start(signal);
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async sendText(target: ReplyTarget, text: string, opts?: SendOptions): Promise<MessageResponse> {
    const resolvedTarget: ReplyTarget = opts?.msgId
      ? { ...target, msgId: opts.msgId }
      : target;
    return this.bot.sendText(resolvedTarget, text);
  }

  async sendMedia(
    target: ReplyTarget,
    source: string,
    opts?: SendOptions & { fileType?: MediaFileType },
  ): Promise<MessageResponse> {
    const resolvedTarget: ReplyTarget = opts?.msgId
      ? { ...target, msgId: opts.msgId }
      : target;
    const fileType = opts?.fileType ?? MediaFileType.IMAGE;
    const sourceOpts = resolveMediaSource(source);
    const result = await this.bot.sendMedia({
      target: resolvedTarget,
      fileType,
      ...sourceOpts,
      content: opts?.text,
    });
    return result.message ?? { id: '', timestamp: Date.now() };
  }

  async sendVoice(
    target: ReplyTarget,
    source: { url?: string; base64?: string; localPath?: string },
    opts?: SendOptions,
  ): Promise<MessageResponse> {
    const resolvedTarget: ReplyTarget = opts?.msgId
      ? { ...target, msgId: opts.msgId }
      : target;

    if (source.base64) {
      const result = await this.bot.sendMedia({
        target: resolvedTarget,
        fileType: MediaFileType.VOICE,
        fileData: source.base64,
        content: opts?.text,
      });
      return result.message ?? { id: '', timestamp: Date.now() };
    }

    if (source.localPath) {
      const result = await this.bot.sendMedia({
        target: resolvedTarget,
        fileType: MediaFileType.VOICE,
        localPath: source.localPath,
        content: opts?.text,
      });
      return result.message ?? { id: '', timestamp: Date.now() };
    }

    const result = await this.bot.sendMedia({
      target: resolvedTarget,
      fileType: MediaFileType.VOICE,
      url: source.url!,
      content: opts?.text,
    });
    return result.message ?? { id: '', timestamp: Date.now() };
  }

  async sendVideo(
    target: ReplyTarget,
    source: string,
    opts?: SendOptions,
  ): Promise<MessageResponse> {
    const resolvedTarget: ReplyTarget = opts?.msgId
      ? { ...target, msgId: opts.msgId }
      : target;
    const sourceOpts = resolveMediaSource(source);
    const result = await this.bot.sendMedia({
      target: resolvedTarget,
      fileType: MediaFileType.VIDEO,
      ...sourceOpts,
      content: opts?.text,
    });
    return result.message ?? { id: '', timestamp: Date.now() };
  }

  async sendFile(
    target: ReplyTarget,
    source: string,
    opts?: SendOptions & { fileName?: string },
  ): Promise<MessageResponse> {
    const resolvedTarget: ReplyTarget = opts?.msgId
      ? { ...target, msgId: opts.msgId }
      : target;
    const sourceOpts = resolveMediaSource(source);
    const result = await this.bot.sendMedia({
      target: resolvedTarget,
      fileType: MediaFileType.FILE,
      ...sourceOpts,
      fileName: opts?.fileName,
      content: opts?.text,
    });
    return result.message ?? { id: '', timestamp: Date.now() };
  }

  openStream(target: ReplyTarget, msgId: string): StreamSession {
    return this.bot.openStream({
      target: { ...target, msgId },
    });
  }

  async sendTyping(target: ReplyTarget): Promise<void> {
    await this.bot.sendTyping(target);
  }
}

function resolveMediaSource(source: string): { url?: string; localPath?: string; fileData?: string } {
  if (source.startsWith('data:')) {
    const commaIdx = source.indexOf(',');
    if (commaIdx > 0) {
      return { fileData: source.slice(commaIdx + 1) };
    }
    return { fileData: source };
  }
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return { url: source };
  }
  if (source.startsWith('file://')) {
    let p = source.slice('file://'.length);
    if (/^\/[a-zA-Z]:[\\/]/.test(p)) p = p.slice(1);
    try { p = decodeURIComponent(p); } catch {}
    return { localPath: p };
  }
  if (source === '~' || source.startsWith('~/') || source.startsWith('~\\')) {
    const os = require('node:os');
    return { localPath: source.replace(/^~/, os.homedir()) };
  }
  if (
    source.startsWith('/') ||
    source.startsWith('./') || source.startsWith('../') ||
    source.startsWith('.\\') || source.startsWith('..\\') ||
    /^[a-zA-Z]:[\\/]/.test(source) ||
    source.startsWith('\\\\')
  ) {
    return { localPath: source };
  }
  return { url: source };
}
