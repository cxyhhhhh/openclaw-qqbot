/**
 * Body 组装器（消息入站 body 组装）
 *
 * SDK 中间件链已经完成了所有预处理：
 *   - ctx.message.content              ← contentSanitizer（face 解析 + mention 清洗）
 *   - ctx.state.quote                  ← quoteRef
 *   - ctx.state.history                ← historyBuffer
 *   - ctx.state.mention                ← mentionGate
 *   - ctx.state.processedAttachments   ← attachmentProcessor（语音 STT、图片 URL）
 *
 * 本模块仅负责"按框架协议把上述上下文拼成最终字符串"，是纯函数。
 *
 * 输出字段语义（与框架 buildCtxPayload 语义一致）：
 *   - webBody    → ctxPayload.Body         （Web UI 展示）
 *   - agentBody  → ctxPayload.BodyForAgent （AI 看到的）
 *   - rawBody    → ctxPayload.RawBody / CommandBody（命令解析、审计）
 *   - systemPrompt → ctxPayload.GroupSystemPrompt
 */
import type {
  MiddlewareContext,
  QQBotInboundMessage,
  ResolvedQuote,
  HistoryEntry,
} from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import type { ProcessedAttachments } from '../gateway/attachment-middleware.js';

// ── 协议常量 ─────────────────────────────
const QUOTE_BEGIN = '[Quoted message begins]';
const QUOTE_END = '[Quoted message ends]';
const HISTORY_CTX_START = '[Chat messages since your last reply — CONTEXT ONLY]';
const HISTORY_CTX_END = '[CURRENT MESSAGE — reply to this]';

export interface AssembledBody {
  /** Web UI 展示用 body */
  webBody: string;
  /** AI 实际接收的 body（dynamicCtx + userMessage [+ history 前缀]） */
  agentBody: string;
  /** 原始 content（命令解析 / 审计用） */
  rawBody: string;
  /** 群系统提示（account.systemPrompt + 群级提示拼接） */
  systemPrompt?: string;
}

/**
 * 把 SDK 中间件链产出的所有上下文组装为框架规约的 body。
 */
export function assembleBody(
  ctx: MiddlewareContext,
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
): AssembledBody {
  const rawBody = msg.content ?? '';
  const isGroup = msg.kind === 'group';

  const mentionState = ctx.state.mention as { wasMentioned?: boolean } | undefined;
  const wasMentioned = mentionState?.wasMentioned ?? false;
  const processed = ctx.state.processedAttachments as ProcessedAttachments | undefined;
  const quote = ctx.state.quote as ResolvedQuote | undefined;
  const history = ctx.state.history as HistoryEntry[] | undefined;

  // ── Layer 1: userContent（清洗后的文本 + 语音转录 + 附件描述） ──
  const userContent = buildUserContent(ctx.message.content ?? '', processed);

  // ── Layer 2: quotePart ──
  const quotePart = buildQuotePart(quote);

  // ── Layer 3: userMessage（群带 [sender] 前缀 + (@you)） ──
  const userMessage = buildUserMessage({
    msg,
    userContent,
    quotePart,
    isGroup,
    wasMentioned,
  });

  // ── Layer 4: dynamicCtx（媒体元数据块） ──
  const dynamicCtx = buildDynamicCtx(processed);

  // ── Layer 5: agentBody（命令直通 / 群被@时前置历史） ──
  const agentBody = buildAgentBody({
    userContent,
    base: dynamicCtx + userMessage,
    isGroup,
    wasMentioned,
    history,
  });

  // ── webBody（暂用 userContent；后续可对接 runtime.channel.reply.formatInboundEnvelope） ──
  const webBody = userContent;

  const systemPrompt = account.systemPrompt?.trim() || undefined;

  return { webBody, agentBody, rawBody, systemPrompt };
}

// ── 局部组装函数 ─────────────────────────────────────────────

/** Layer 1：sanitized + 语音转录 + 附件描述 */
function buildUserContent(sanitizedRaw: string, processed: ProcessedAttachments | undefined): string {
  const sanitized = sanitizedRaw.trim();
  const voiceText = processed?.voiceText ?? '';
  const attachmentInfo = processed?.otherInfo ? `\n${processed.otherInfo}` : '';

  if (voiceText) {
    return (sanitized ? `${sanitized}\n${voiceText}` : voiceText) + attachmentInfo;
  }
  return sanitized + attachmentInfo;
}

/** Layer 2：[Quoted message begins]…[Quoted message ends] */
function buildQuotePart(quote: ResolvedQuote | undefined): string {
  if (!quote) return '';
  const text = quote.text || 'Original content unavailable';
  return `${QUOTE_BEGIN}\n${text}\n${QUOTE_END}\n`;
}

/** Layer 3：[Sender] {quote}{content}{(@you)?} */
function buildUserMessage(input: {
  msg: QQBotInboundMessage;
  userContent: string;
  quotePart: string;
  isGroup: boolean;
  wasMentioned: boolean;
}): string {
  const { msg, userContent, quotePart, isGroup, wasMentioned } = input;
  const atYouTag = isGroup && wasMentioned ? ' (@you)' : '';

  if (isGroup) {
    const senderLabel = formatSenderLabel(msg.senderName, msg.senderId);
    return `[${senderLabel}] ${quotePart}${userContent}${atYouTag}`;
  }
  return `${quotePart}${userContent}`;
}

/** Layer 4：- Images / - Voice / - ASR 元数据块 */
function buildDynamicCtx(processed: ProcessedAttachments | undefined): string {
  if (!processed) return '';
  const lines: string[] = [];

  // Images
  if (processed.imageUrls.length > 0) {
    lines.push(`- Images: ${processed.imageUrls.join(', ')}`);
  }

  // Voice：从 transcripts 行存投影出 paths + urls，去重后拼接
  const transcripts = processed.transcripts ?? [];
  const voiceRefs = unique([
    ...transcripts.map((t) => t.localPath).filter(isNonEmpty),
    ...transcripts.map((t) => t.remoteUrl).filter(isNonEmpty),
  ]);
  if (voiceRefs.length > 0) {
    lines.push(`- Voice: ${voiceRefs.join(', ')}`);
  }

  // ASR：source==='asr' 的 text，或任意 transcript 上的 asrReferText
  const asrTexts = unique(
    transcripts
      .map((t) => (t.source === 'asr' ? t.text : t.asrReferText))
      .filter(isNonEmpty),
  );
  if (asrTexts.length > 0) {
    lines.push(`- ASR: ${asrTexts.join(' | ')}`);
  }

  return lines.length > 0 ? `${lines.join('\n')}\n\n` : '';
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function isNonEmpty(x: string | undefined): x is string {
  return typeof x === 'string' && x.length > 0;
}

/** Layer 5：base = dynamicCtx+userMessage；命令直通；群被@叠历史前缀 */
function buildAgentBody(input: {
  userContent: string;
  base: string;
  isGroup: boolean;
  wasMentioned: boolean;
  history: HistoryEntry[] | undefined;
}): string {
  const { userContent, base, isGroup, wasMentioned, history } = input;

  // 斜杠命令直通：去除一切装饰
  if (userContent.startsWith('/')) {
    return userContent;
  }

  if (isGroup && wasMentioned && history && history.length > 0) {
    const historyText = history
      .map((h) => {
        const label = formatSenderLabel(h.senderName, h.senderId);
        return `[${label}] ${h.content}`;
      })
      .join('\n');
    return [HISTORY_CTX_START, historyText, '', HISTORY_CTX_END, base].join('\n');
  }

  return base;
}

/** "Nick (openid)" 标签；当 name 已含 id 时避免双重包裹 */
function formatSenderLabel(name: string | undefined, id: string): string {
  if (!name) return id;
  return name.includes(id) ? name : `${name} (${id})`;
}
