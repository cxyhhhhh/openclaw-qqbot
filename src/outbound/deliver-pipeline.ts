/**
 * 出站 Deliver Pipeline — 处理 AI 回复的富媒体分发
 *
 * 4 层 Pipeline：
 *   1. 媒体标签解析 — <qqimg>/<qqvoice>/<qqvideo>/<qqfile>/<qqmedia>
 *   2. 结构化载荷 — "QQBOT_PAYLOAD:" JSON 前缀
 *   3. 语音意图 — audioAsVoice (TTS → SILK → 发送)
 *   4. 纯文本回复 — markdown 图片/bare URL 提取 + 本地路径路由 + tool media 聚合
 */
import { hasMediaTags, extractMediaTags, type MediaTagType } from './media-tags.js';
import { sendMedia } from './media-send.js';
import type { MediaKind, SendResult } from './outbound-service.js';

// ── 类型 ──

export interface DeliverPayload {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
}

export interface DeliverInfo {
  kind: string;
}

export interface DeliverContext {
  qualifiedTarget: string;
  accountId: string;
  replyToId: string;
  /** 会话类型（用于判断语音是否可用） */
  chatScope?: 'direct' | 'group';
  /** 发送文本 */
  sendText: (to: string, text: string) => Promise<SendResult>;
  /** 发送媒体（保留兼容，内部建议用 sendMedia） */
  sendMedia: (to: string, source: string, opts?: { text?: string; mediaKind?: MediaKind }) => Promise<SendResult>;
  /** TTS 文字转语音（返回本地音频路径，失败返回 null） */
  textToSpeech?: (params: { text: string; cfg?: unknown; channel?: string; accountId?: string }) => Promise<{ audioPath: string | null; error?: string }>;
  /** 音频文件转 SILK Base64（QQ 语音格式） */
  audioFileToSilkBase64?: (audioPath: string) => Promise<string | null>;
  /** 运行时配置 */
  cfg?: unknown;
  /** 日志 */
  log?: { info: (m: string) => void; error: (m: string) => void; debug?: (m: string) => void };
}

/**
 * Tool media 收集器（跨 deliver 调用积累 tool 返回的 mediaUrl）
 */
export class ToolMediaCollector {
  private urls: string[] = [];

  add(url: string): void {
    if (url) this.urls.push(url);
  }

  addAll(urls: string[]): void {
    for (const u of urls) {
      if (u) this.urls.push(u);
    }
  }

  drain(): string[] {
    const result = [...this.urls];
    this.urls = [];
    return result;
  }

  get length(): number {
    return this.urls.length;
  }
}

/**
 * 4 层出站 Deliver Pipeline
 *
 * 按顺序尝试，短路返回：
 * 1. 媒体标签 → 解析发送
 * 2. 结构化载荷 → JSON 分发
 * 3. 语音意图 → TTS
 * 4. 纯文本 → markdown 图片/bare URL/本地路径 + tool media
 */
export async function deliverReply(
  payload: DeliverPayload,
  info: DeliverInfo | undefined,
  ctx: DeliverContext,
  toolMedia: ToolMediaCollector,
): Promise<void> {
  let text = payload.text?.trim() ?? '';

  // ── TTS 兜底：框架可能剥离了 [[tts:text]]...[[/tts:text]] 中的内容 ──
  // 当 text 为空或仅剩空白，但 payload 中有 audioAsVoice 标记时
  // 说明 TTS 合成失败或不可用，降级为文本直发
  if (!text && payload.audioAsVoice) {
    // TTS payload with empty text — will fallback at Layer 3
  }

  // ── Tool media 收集 ──
  if (info?.kind === 'tool') {
    if (payload.mediaUrl) toolMedia.add(payload.mediaUrl);
    if (payload.mediaUrls) toolMedia.addAll(payload.mediaUrls);
    // tool deliver 仅收集，不直接发送（等 block 回复统一发）
    return;
  }

  // ── Layer 1: 媒体标签 ──
  if (text && hasMediaTags(text)) {
    const { tags, cleanText } = extractMediaTags(text);
    if (tags.length > 0) {
      for (const tag of tags) {
        await sendMediaSource(ctx, tag.source, { mediaKind: mapTagToMediaKind(tag.tag) });
      }
      if (cleanText) {
        await ctx.sendText(ctx.qualifiedTarget, cleanText);
      }
      // 追加 tool media
      await flushToolMedia(ctx, toolMedia);
      return;
    }
  }

  // ── Layer 2: 结构化载荷 QQBOT_PAYLOAD: ──
  if (text.startsWith('QQBOT_PAYLOAD:')) {
    const handled = await handleStructuredPayload(text, ctx);
    if (handled) {
      await flushToolMedia(ctx, toolMedia);
      return;
    }
  }

  // ── Layer 3: 语音意图 ──
  if (payload.audioAsVoice) {
    if (ctx.textToSpeech && text) {
      const handled = await handleVoiceIntent(text, ctx);
      if (handled) {
        await flushToolMedia(ctx, toolMedia);
        return;
      }
    }
    // TTS 不可用或合成失败 → 降级为纯文本
    if (!text) {
      return;
    }
    // 继续到 Layer 4 作为纯文本发送
  }

  // ── Layer 4: 纯文本回复 + 图片提取 + tool media ──
  await sendPlainReply(text, payload, ctx, toolMedia);
}

// ── Layer 1 辅助 ──

function mapTagToMediaKind(tag: MediaTagType): MediaKind {
  switch (tag) {
    case 'qqvoice': return 'voice';
    case 'qqvideo': return 'video';
    case 'qqfile': return 'file';
    case 'qqimg':
    case 'qqmedia':
    default: return 'image';
  }
}

// ── Layer 2: 结构化载荷 ──

interface QQBotPayload {
  type: string;
  mediaType?: string;
  source?: string;
  text?: string;
  [key: string]: unknown;
}

async function handleStructuredPayload(text: string, ctx: DeliverContext): Promise<boolean> {
  const jsonStr = text.slice('QQBOT_PAYLOAD:'.length).trim();
  let parsed: QQBotPayload;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return false;
  }

  if (parsed.type === 'media' && parsed.source) {
    const kind = inferMediaKindFromString(parsed.mediaType);
    await sendMediaSource(ctx, parsed.source, { mediaKind: kind, text: parsed.text });
    return true;
  }

  if (parsed.type === 'cron_reminder') {
    // 定时消息：发送确认文本（完整实现在 #12 Cron 项）
    const confirmText = parsed.text ?? `⏰ Reminder scheduled`;
    await ctx.sendText(ctx.qualifiedTarget, confirmText);
    return true;
  }

  return false;
}

function inferMediaKindFromString(mediaType: string | undefined): MediaKind {
  if (!mediaType) return 'file';
  const lower = mediaType.toLowerCase();
  if (lower === 'image' || lower.startsWith('image/')) return 'image';
  if (lower === 'audio' || lower === 'voice' || lower.startsWith('audio/')) return 'voice';
  if (lower === 'video' || lower.startsWith('video/')) return 'video';
  return 'file';
}

// ── Layer 3: 语音意图 ──

async function handleVoiceIntent(text: string, ctx: DeliverContext): Promise<boolean> {
  if (!text || !ctx.textToSpeech) return false;

  // 仅 c2c/group 支持语音消息；其他场景 fallback 发文本
  if (ctx.chatScope && ctx.chatScope !== 'direct' && ctx.chatScope !== 'group') {
    return false;
  }

  try {
    const ttsResult = await ctx.textToSpeech({
      text,
      cfg: ctx.cfg,
      channel: 'qqbot',
      accountId: ctx.accountId,
    });

    if (!ttsResult.audioPath) {
      ctx.log?.error(`[deliver:tts] TTS failed: ${ttsResult.error ?? 'no audio path returned'}`);
      return false;
    }

    // 优先走 SILK base64
    if (ctx.audioFileToSilkBase64) {
      const silkBase64 = await ctx.audioFileToSilkBase64(ttsResult.audioPath);
      if (silkBase64) {
        const result = await ctx.sendMedia(ctx.qualifiedTarget, silkBase64, { mediaKind: 'voice' });
        if (result.error) ctx.log?.error(`[deliver:tts] sendVoice(base64) failed: ${result.error}`);
        return !result.error;
      }
      ctx.log?.error(`[deliver:tts] SILK conversion failed, trying localPath fallback`);
    }

    // Fallback: 直接发本地路径（SDK 内部处理格式转换）
    const result = await ctx.sendMedia(ctx.qualifiedTarget, ttsResult.audioPath, { mediaKind: 'voice' });
    if (result.error) {
      ctx.log?.error(`[deliver:tts] sendVoice(localPath) failed: ${result.error}`);
      return false;
    }
    return true;
  } catch (err) {
    ctx.log?.error(`[deliver:tts] TTS/voice send failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── Layer 4: 纯文本回复 ──

/** Markdown 图片正则 */
const MARKDOWN_IMG_RE = /!\[[^\]]*\]\(([^)]+)\)/gi;

/** 裸图片 URL 正则 */
const BARE_IMAGE_URL_RE = /(https?:\/\/[^\s<>"']+\.(?:png|jpg|jpeg|gif|webp|bmp|svg)(?:\?[^\s<>"']*)?)/gi;

async function sendPlainReply(
  text: string,
  payload: DeliverPayload,
  ctx: DeliverContext,
  toolMedia: ToolMediaCollector,
): Promise<void> {
  // 收集所有图片源
  const imageUrls: string[] = [];

  // 来自 payload
  if (payload.mediaUrl) imageUrls.push(payload.mediaUrl);
  if (payload.mediaUrls) imageUrls.push(...payload.mediaUrls);

  // 从文本中提取 markdown 图片
  let cleanText = text;
  let match: RegExpExecArray | null;

  MARKDOWN_IMG_RE.lastIndex = 0;
  while ((match = MARKDOWN_IMG_RE.exec(text)) !== null) {
    imageUrls.push(match[1]);
    cleanText = cleanText.replace(match[0], '');
  }

  // 从文本中提取 bare URL 图片
  BARE_IMAGE_URL_RE.lastIndex = 0;
  const bareMatches: string[] = [];
  while ((match = BARE_IMAGE_URL_RE.exec(cleanText)) !== null) {
    // 避免重复（已在 markdown 中提取过）
    if (!imageUrls.includes(match[1])) {
      bareMatches.push(match[1]);
    }
  }
  for (const bare of bareMatches) {
    imageUrls.push(bare);
    cleanText = cleanText.replace(bare, '');
  }

  // 清理文本中的多余空行
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

  // 发送图片
  for (const url of imageUrls) {
    await sendMediaSource(ctx, url, { mediaKind: 'image' });
  }

  // 发送 tool media
  await flushToolMedia(ctx, toolMedia);

  // 发送纯文本
  if (cleanText) {
    const result = await ctx.sendText(ctx.qualifiedTarget, cleanText);
    if (result.error) {
      ctx.log?.error(`[deliver:plain] sendText failed: ${result.error}`);
    }
  } else if (imageUrls.length === 0 && toolMedia.length === 0) {
    // nothing to send
  }
}

// ── 通用发送辅助 ──

/**
 * 智能发送媒体源：本地路径 / data URL / 远程 URL 自动路由
 */
/**
 * 智能发送媒体源：通过 sendMedia 统一入口（安全校验 + 类型推断 + fallback）
 */
async function sendMediaSource(
  ctx: DeliverContext,
  source: string,
  opts?: { mediaKind?: MediaKind; text?: string },
): Promise<void> {
  const result = await sendMedia({
    to: ctx.qualifiedTarget,
    source,
    text: opts?.text,
    mediaKind: opts?.mediaKind,
    replyToId: ctx.replyToId,
    accountId: ctx.accountId,
    log: ctx.log ? { ...ctx.log, warn: ctx.log.info } : undefined,
  });
  if (result.error) {
    ctx.log?.error(`[deliver:media] ${result.error}`);
  }
}

async function flushToolMedia(ctx: DeliverContext, toolMedia: ToolMediaCollector): Promise<void> {
  const urls = toolMedia.drain();
  for (const url of urls) {
    await sendMediaSource(ctx, url);
  }
}
