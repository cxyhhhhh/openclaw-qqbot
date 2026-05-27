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
import { setupMiddlewares } from './middleware-setup.js';
import { handleMessage, handleInteraction } from './event-handlers.js';
import { getQQBotDataDir } from '../utils/platform.js';
import { buildUserAgent } from '../bot-instance.js';

export interface GatewayCallbacks {
  onReady?: () => void;
  onError?: (error: Error) => void;
}

export interface GatewayLogSink {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface SendOptions {
  msgId?: string;
  text?: string;
}

export class QQBotGateway {
  readonly bot: QQBot;
  private readonly account: ResolvedQQBotAccount;
  private readonly runtime: PluginRuntime;
  private readonly log: GatewayLogSink;

  constructor(account: ResolvedQQBotAccount, runtime: PluginRuntime, log?: GatewayLogSink) {
    this.account = account;
    this.runtime = runtime;
    this.log = log ?? { info: console.log, warn: console.warn, error: console.error, debug: console.log };

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
      logger: this.createLogger(),
    });

    // 编排中间件（仅过滤 + 富化，不含业务转发）
    setupMiddlewares(this.bot, account);
  }

  /**
   * 启动 Bot 连接
   */
  async start(callbacks?: GatewayCallbacks, signal?: AbortSignal): Promise<void> {
    // 绑定事件
    this.bot.on('ready', () => {
      this.log.info(`[qqbot:${this.account.accountId}] Gateway ready`);
      callbacks?.onReady?.();
    });

    this.bot.on('error', (err: Error) => {
      this.log.error(`[qqbot:${this.account.accountId}] Gateway error: ${err.message}`);
      callbacks?.onError?.(err);
    });

    // message 事件 = 中间件全部执行完毕后到达
    this.bot.on('message', (ctx: MiddlewareContext, msg: QQBotInboundMessage) => {
      handleMessage(ctx, msg, this.account, this.runtime, this.log).catch((err) => {
        this.log.error(`[qqbot:${this.account.accountId}] Dispatch error: ${err}`);
      });
    });

    // interaction 事件（按钮点击）
    this.bot.on('interaction', (_ctx, event: InteractionEvent) => {
      handleInteraction(event, this.account, this.runtime, (id) =>
        this.bot.acknowledgeInteraction(id),
      ).catch((err) => {
        this.log.error(`[qqbot:${this.account.accountId}] Interaction error: ${err}`);
      });
    });

    // 启动 WebSocket 连接
    await this.bot.start();

    // 中止信号
    signal?.addEventListener('abort', () => this.stop(), { once: true });
  }

  /**
   * 停止 Bot 连接
   */
  async stop(): Promise<void> {
    await this.bot.stop();
  }

  // ── 出站方法（供 outbound 层调用）──

  async sendText(target: ReplyTarget, text: string, opts?: SendOptions): Promise<MessageResponse> {
    const resolvedTarget: ReplyTarget = opts?.msgId
      ? { ...target, msgId: opts.msgId }
      : target;
    return this.bot.sendText(resolvedTarget, text);
  }

  async sendMedia(
    target: ReplyTarget,
    source: string,
    opts?: SendOptions,
  ): Promise<MessageResponse> {
    const resolvedTarget: ReplyTarget = opts?.msgId
      ? { ...target, msgId: opts.msgId }
      : target;
    const result = await this.bot.sendMedia({
      target: resolvedTarget,
      fileType: MediaFileType.IMAGE,
      url: source,
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

  // ── 内部方法 ──

  private createLogger() {
    return {
      info: (msg: string) => this.log.info(msg),
      error: (msg: string) => this.log.error(msg),
      warn: (msg: string) => this.log.warn(msg),
      debug: (msg: string) => {
        if (process.env.QQBOT_DEBUG) this.log.debug?.(msg);
      },
    };
  }
}
