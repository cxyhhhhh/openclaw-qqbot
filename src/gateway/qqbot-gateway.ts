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
    setupMiddlewares(this.bot, account, {
      getRuntime: () => runtime,
    });
  }

  /**
   * 启动 Bot 连接
   *
   * 注意：QQBot.start() 是一个长阻塞调用 — 它会持续 await 直到 transport 断开
   * （由 abortSignal 触发或 bot.stop() 主动停止）。因此：
   *   1. 所有事件监听必须在 start() **之前** 注册
   *   2. abortSignal 必须直接传给 SDK（透传到 SDK 内部的 abortController），
   *      不能用 addEventListener 后绑 —— 后绑代码永远不会执行
   */
  async start(callbacks?: GatewayCallbacks, signal?: AbortSignal): Promise<void> {
    // 1. 事件绑定 — 必须在 bot.start() 之前完成
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

    // 2. 启动 WebSocket 连接（长阻塞调用）—— signal 直接透传给 SDK
    //    SDK 内部会监听 signal.abort，触发后停止 transport 并解除阻塞
    await this.bot.start(signal);
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

  /**
   * 发送语音消息（Base64 / URL / 本地路径）
   */
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

  /**
   * 发送视频消息
   */
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

  /**
   * 发送文件消息
   */
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

  // ── 内部方法 ──

  private createLogger() {
    return {
      info: (msg: string) => this.log.info(msg),
      error: (msg: string) => this.log.error(msg),
      warn: (msg: string) => this.log.warn(msg),
      debug: (msg: string) => this.log.debug?.(msg),
    };
  }
}

// ── 媒体源路由：本地路径 / data URL / 远程 URL ──

function resolveMediaSource(source: string): { url?: string; localPath?: string; fileData?: string } {
  // Base64 data URL
  if (source.startsWith('data:')) {
    const commaIdx = source.indexOf(',');
    if (commaIdx > 0) {
      return { fileData: source.slice(commaIdx + 1) };
    }
    return { fileData: source };
  }
  // 远程 URL
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return { url: source };
  }
  // 本地路径（支持所有常见格式）
  // file:// 协议
  if (source.startsWith('file://')) {
    let p = source.slice('file://'.length);
    if (/^\/[a-zA-Z]:[\\/]/.test(p)) p = p.slice(1);
    try { p = decodeURIComponent(p); } catch {}
    return { localPath: p };
  }
  // ~ home 路径
  if (source === '~' || source.startsWith('~/') || source.startsWith('~\\')) {
    const os = require('node:os');
    return { localPath: source.replace(/^~/, os.homedir()) };
  }
  // Unix 绝对 / 相对 / Windows 盘符 / UNC
  if (
    source.startsWith('/') ||
    source.startsWith('./') || source.startsWith('../') ||
    source.startsWith('.\\') || source.startsWith('..\\') ||
    /^[a-zA-Z]:[\\/]/.test(source) ||
    source.startsWith('\\\\')
  ) {
    return { localPath: source };
  }
  // 无法判断 → 当 URL 兜底
  return { url: source };
}