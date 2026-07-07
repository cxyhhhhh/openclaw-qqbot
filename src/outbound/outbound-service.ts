/**
 * 出站消息服务
 *
 * 负责将 AI 回复通过 SDK 发送到 QQ。
 * 由 ChannelPlugin.outbound.sendText / sendMedia 调用。
 */
import * as path from 'node:path';
import { MediaFileType } from '@tencent-connect/qqbot-nodejs';
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

// ── 媒体类型映射 ──

export type MediaKind = 'image' | 'voice' | 'video' | 'file';

const MEDIA_KIND_TO_FILE_TYPE: Record<MediaKind, MediaFileType> = {
  image: MediaFileType.IMAGE,
  voice: MediaFileType.VOICE,
  video: MediaFileType.VIDEO,
  file: MediaFileType.FILE,
};

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
 * 支持 mediaKind 参数区分 image/voice/video/file
 */
export async function sendMedia(params: {
  to: string;
  text?: string;
  mediaUrl: string;
  mediaKind?: MediaKind;
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
    const kind = params.mediaKind ?? 'image';

    // 语音消息走专用方法（支持 本地路径 / Base64 / URL）
    if (kind === 'voice') {
      const isLocalPath = params.mediaUrl.startsWith('/') || params.mediaUrl.startsWith('./') || params.mediaUrl.startsWith('../');
      const isUrl = params.mediaUrl.startsWith('http://') || params.mediaUrl.startsWith('https://');
      const source = isLocalPath
        ? { localPath: params.mediaUrl }
        : isUrl
          ? { url: params.mediaUrl }
          : { base64: params.mediaUrl };
      const result = await gw.sendVoice(
        target,
        source,
        { text: params.text, msgId: params.replyToId },
      );
      return { messageId: result.id };
    }

    // 视频走专用方法
    if (kind === 'video') {
      const result = await gw.sendVideo(target, params.mediaUrl, {
        text: params.text,
        msgId: params.replyToId,
      });
      return { messageId: result.id };
    }

    // 文件走专用方法
    if (kind === 'file') {
      const result = await gw.sendFile(target, params.mediaUrl, {
        text: params.text,
        msgId: params.replyToId,
      });
      return { messageId: result.id };
    }

    // 图片（默认）
    const fileType = MEDIA_KIND_TO_FILE_TYPE[kind];
    const result = await gw.sendMedia(target, params.mediaUrl, {
      text: params.text,
      msgId: params.replyToId,
      fileType,
    });
    return { messageId: result.id };
  } catch (err: unknown) {
    return formatError(err);
  }
}

/**
 * 发送语音消息（便捷方法）
 */
export async function sendVoice(params: {
  to: string;
  source: { url?: string; base64?: string };
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
    const result = await gw.sendVoice(target, params.source, { msgId: params.replyToId });
    return { messageId: result.id };
  } catch (err: unknown) {
    return formatError(err);
  }
}

/**
 * 发送视频消息（便捷方法）
 */
export async function sendVideo(params: {
  to: string;
  videoUrl: string;
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
    const result = await gw.sendVideo(target, params.videoUrl, { msgId: params.replyToId });
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

  async sendMedia(to: string, source: string, opts?: { text?: string; msgId?: string; mediaKind?: MediaKind }): Promise<SendResult> {
    try {
      const target = parseTarget(to);
      const kind = opts?.mediaKind ?? 'image';

      if (kind === 'voice') {
        const isLocalPath = source.startsWith('/') || source.startsWith('./') || source.startsWith('../');
        const isUrl = source.startsWith('http://') || source.startsWith('https://');
        const voiceSource = isLocalPath
          ? { localPath: source }
          : isUrl
            ? { url: source }
            : { base64: source };
        const result = await this.gw.sendVoice(
          target,
          voiceSource,
          { text: opts?.text, msgId: opts?.msgId },
        );
        return { messageId: result.id };
      }

      if (kind === 'video') {
        const result = await this.gw.sendVideo(target, source, { text: opts?.text, msgId: opts?.msgId });
        return { messageId: result.id };
      }

      if (kind === 'file') {
        const fileName = path.basename(source);
        const result = await this.gw.sendFile(target, source, { text: opts?.text, msgId: opts?.msgId, fileName });
        return { messageId: result.id };
      }

      const fileType = MEDIA_KIND_TO_FILE_TYPE[kind];
      const result = await this.gw.sendMedia(target, source, { text: opts?.text, msgId: opts?.msgId, fileType });
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
