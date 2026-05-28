/**
 * 入站附件处理中间件
 *
 * 处理入站消息中的语音/图片/视频附件：
 * - 语音：下载 → SILK转WAV → STT转文字 → 写入 ctx.state.processedAttachments
 * - 图片：提取 URL 列表
 * - 其他：标记为附件描述
 *
 * 插入位置：envelopeFormatter 之前
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import {
  convertSilkToWav,
  isVoiceAttachment,
} from '@tencent-connect/qqbot-nodejs/protocol';
import type { MessageAttachment } from '../types.js';
import { transcribeAudio, resolveSTTConfig } from '../utils/stt.js';
import { formatVoiceText, formatDuration, type VoiceTranscript, type TranscriptSource } from '../utils/voice-text.js';
import { getQQBotDataDir } from '../utils/platform.js';

export { formatVoiceText, formatDuration };
export type { VoiceTranscript, TranscriptSource };

/** 处理后的附件结果（写入 ctx.state.processedAttachments） */
export interface ProcessedAttachments {
  voiceText: string;
  imageUrls: string[];
  otherInfo: string;
  transcripts: VoiceTranscript[];
}

interface AttachmentMiddlewareOptions {
  /** 获取当前配置（延迟求值） */
  getCfg: () => Record<string, unknown>;
}

/**
 * 附件处理中间件
 *
 * SDK ctx 已提供 log 和 accountId，只需传入配置获取函数。
 */
export function attachmentProcessor(opts: AttachmentMiddlewareOptions) {
  return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
    const msg = ctx.message;
    const attachments = msg.attachments as MessageAttachment[] | undefined;

    if (attachments?.length) {
      const cfg = opts.getCfg();
      const accountId = (ctx.bot as any).accountId ?? 'default';
      const log = ctx.log;
      const result = await processAttachments(attachments, cfg, accountId, log);

      if (result.voiceText || result.imageUrls.length > 0 || result.otherInfo) {
        ctx.state.processedAttachments = result;
      }
    }

    await next();
  };
}

// ── 核心处理逻辑 ──

type Log = { info: (m: string) => void; error: (m: string) => void; debug?: (m: string) => void };

async function processAttachments(
  attachments: MessageAttachment[],
  cfg: Record<string, unknown>,
  accountId: string,
  log?: Log,
): Promise<ProcessedAttachments> {
  const downloadDir = ensureDir(path.join(getQQBotDataDir(accountId), 'downloads'));
  const sttCfg = resolveSTTConfig(cfg);
  const audioPolicy = resolveAudioPolicy(cfg);

  const imageUrls: string[] = [];
  const otherParts: string[] = [];
  const transcripts: VoiceTranscript[] = [];

  for (const att of attachments) {
    const isVoice = isVoiceAttachment(att);
    const isImage = att.content_type?.startsWith('image/');

    if (isImage) {
      const url = normalizeUrl(att.url);
      if (url) imageUrls.push(url);
      continue;
    }

    if (isVoice) {
      const transcript = await processVoiceAttachment(att, sttCfg, audioPolicy, downloadDir, log);
      transcripts.push(transcript);
      continue;
    }

    otherParts.push(`[Attachment: ${att.filename ?? att.content_type}]`);
  }

  return {
    voiceText: formatVoiceText(transcripts),
    imageUrls,
    otherInfo: otherParts.join('\n'),
    transcripts,
  };
}

// ── 语音处理 ──

async function processVoiceAttachment(
  att: MessageAttachment,
  sttCfg: ReturnType<typeof resolveSTTConfig>,
  audioPolicy: AudioPolicyResolved,
  downloadDir: string,
  log?: Log,
): Promise<VoiceTranscript> {
  const asrReferText = att.asr_refer_text?.trim() || undefined;
  // 远端 URL 兜底：优先 wav_url，其次原始 url
  const remoteUrl = normalizeUrl(att.voice_wav_url) || normalizeUrl(att.url) || undefined;

  // STT 未配置：直接走 ASR / fallback
  if (!sttCfg) {
    if (asrReferText) {
      log?.debug?.(`Voice: using asr_refer_text (STT not configured)`);
      return { text: asrReferText, source: 'asr', asrReferText, remoteUrl };
    }
    return {
      text: '[Voice message - transcription unavailable]',
      source: 'fallback',
      asrReferText,
      remoteUrl,
    };
  }

  let localPath: string | undefined;
  let duration: number | undefined;

  try {
    const wavUrl = normalizeUrl(att.voice_wav_url);
    if (wavUrl) {
      const downloaded = await downloadFile(wavUrl, downloadDir);
      if (downloaded) {
        localPath = downloaded;
        log?.debug?.(`Voice: downloaded WAV from voice_wav_url`);
      }
    }

    if (!localPath) {
      const silkUrl = normalizeUrl(att.url);
      if (silkUrl) {
        const silkPath = await downloadFile(silkUrl, downloadDir, att.filename);
        if (silkPath) {
          const ext = path.extname(silkPath).toLowerCase();
          if (audioPolicy.sttDirectFormats.includes(ext)) {
            localPath = silkPath;
          } else {
            const wavResult = await convertSilkToWav(silkPath);
            if (wavResult) {
              localPath = wavResult.wavPath;
              duration = wavResult.duration / 1000;
              log?.debug?.(`Voice: SILK→WAV (${formatDuration(duration)})`);
            } else {
              localPath = silkPath;
            }
          }
        }
      }
    }
  } catch (err) {
    log?.error(`Voice download/convert failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (localPath) {
    try {
      const transcript = await transcribeAudio(localPath, cfg2stt(sttCfg));
      if (transcript) {
        log?.debug?.(`Voice STT: ${transcript.slice(0, 80)}...`);
        return { text: transcript, source: 'stt', duration, localPath, remoteUrl, asrReferText };
      }
    } catch (err) {
      log?.error(`Voice STT failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (asrReferText) {
    return { text: asrReferText, source: 'asr', duration, localPath, remoteUrl, asrReferText };
  }

  return {
    text: '[Voice message - transcription failed]',
    source: 'fallback',
    duration,
    localPath,
    remoteUrl,
    asrReferText,
  };
}

// ── 配置 ──

interface AudioPolicyResolved {
  sttDirectFormats: string[];
  uploadDirectFormats: string[];
  transcodeEnabled: boolean;
}

function resolveAudioPolicy(cfg: Record<string, unknown>): AudioPolicyResolved {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const qqbot = channels?.qqbot as Record<string, unknown> | undefined;
  const policy = qqbot?.audioFormatPolicy as Record<string, unknown> | undefined;

  return {
    sttDirectFormats: normalizeFormats((policy?.sttDirectFormats as string[]) ?? []),
    uploadDirectFormats: normalizeFormats(
      (policy?.uploadDirectFormats as string[]) ??
      (qqbot?.voiceDirectUploadFormats as string[]) ??
      ['.wav', '.mp3', '.silk'],
    ),
    transcodeEnabled: (policy?.transcodeEnabled as boolean) !== false,
  };
}

function normalizeFormats(formats: string[]): string[] {
  return formats.map((f) => {
    const lower = f.toLowerCase().trim();
    return lower.startsWith('.') ? lower : `.${lower}`;
  });
}

function cfg2stt(sttCfg: NonNullable<ReturnType<typeof resolveSTTConfig>>): Record<string, unknown> {
  return { channels: { qqbot: { stt: sttCfg } } };
}

// ── 文件工具 ──

function normalizeUrl(url: string | undefined): string {
  if (!url) return '';
  return url.startsWith('//') ? `https:${url}` : url;
}

function ensureDir(dir: string): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

async function downloadFile(url: string, dir: string, filename?: string): Promise<string | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    const ext = filename ? path.extname(filename) : guessExtFromUrl(url);
    const name = `voice_${Date.now()}${ext || '.bin'}`;
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch {
    return null;
  }
}

function guessExtFromUrl(url: string): string {
  try {
    return path.extname(new URL(url).pathname) || '.bin';
  } catch {
    return '.bin';
  }
}
