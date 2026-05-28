/**
 * 消息转发 — 入站消息 → OpenClaw AI
 *
 * 核心职责：
 * 1. 从 SDK MiddlewareContext 构建 OpenClaw 标准信封
 * 2. 通过 runtime.channel.turn.run() 将消息交给 AI 处理
 *
 * 架构说明：
 * - runtime: 全局 PluginRuntime（register 阶段注入），提供 channel.turn.run / channel.reply 等
 * - log: per-account 日志（从 ctx.log 透传），用于运行时日志输出
 */
import type { MiddlewareContext, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { ResolvedQQBotAccount } from '../types.js';
import type { GatewayLogSink } from '../gateway/qqbot-gateway.js';
import { buildEnvelope } from './envelope-builder.js';
import { assembleBody, type AssembledBody } from './body-assembler.js';
import { sendText, sendMedia, type MediaKind } from '../outbound/outbound-service.js';
import { extractMediaTags, hasMediaTags, type MediaTagType } from '../outbound/media-tags.js';

/**
 * 将经过中间件处理的入站消息转发给 OpenClaw AI
 */
export async function dispatchToOpenClaw(
  ctx: MiddlewareContext,
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log?: GatewayLogSink,
): Promise<void> {
  const envelope = buildEnvelope(ctx, msg, account);

  // 优先使用 envelopeFormatter 中间件缓存的组装结果，fallback 即时组装
  const assembled: AssembledBody =
    ((ctx.state as Record<string, unknown>).assembledBody as AssembledBody | undefined) ??
    assembleBody(ctx, msg, account);

  const channel = runtime.channel as any;

  if (!channel?.turn?.run) {
    log?.error(`[qqbot:${account.accountId}] runtime.channel.turn.run not available`);
    return;
  }

  const cfg = (runtime.config as any)?.current?.() ?? (runtime as any).getConfig?.();

  // 解析路由
  const route = channel.routing?.resolveAgentRoute?.({
    cfg,
    channel: 'qqbot',
    accountId: account.accountId,
    peer: {
      kind: envelope.chatScope === 'group' ? 'group' : 'direct',
      id: envelope.chatScope === 'group' ? (envelope.groupId ?? envelope.senderId) : envelope.senderId,
    },
  }) ?? { sessionKey: `qqbot:${account.accountId}:${envelope.senderId}`, accountId: account.accountId };

  const qualifiedTarget = envelope.targetId;
  const agentId = route.agentId ?? 'default';
  const storePath = channel.session?.resolveStorePath?.((cfg as any)?.session?.store, { agentId }) ?? '';

  // Web UI Body：通过 runtime 渲染（低版本 openclaw 降级为 userContent）
  const isGroup = envelope.chatScope === 'group';
  const webBody = renderWebBody(channel, cfg, assembled, msg, isGroup);

  // 构建框架标准 MsgContext（对标内置版 buildCtxPayload）
  const ctxPayload = channel.reply?.finalizeInboundContext?.({
    Body: webBody,
    BodyForAgent: assembled.agentBody,
    RawBody: assembled.rawBody,
    CommandBody: assembled.rawBody,
    From: envelope.targetId,
    To: envelope.targetId,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: envelope.chatScope === 'group' ? 'group' : 'direct',
    GroupSystemPrompt: assembled.systemPrompt,
    SenderId: envelope.senderId,
    SenderName: envelope.senderName,
    Provider: 'qqbot',
    Surface: 'qqbot',
    MessageSid: envelope.messageId,
    Timestamp: Date.now(),
    OriginatingChannel: 'qqbot',
    OriginatingTo: envelope.targetId,
    CommandAuthorized: false,
  }) ?? {
    Body: webBody,
    BodyForAgent: assembled.agentBody,
    RawBody: assembled.rawBody,
    CommandBody: assembled.rawBody,
    From: envelope.targetId,
    To: envelope.targetId,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: envelope.chatScope === 'group' ? 'group' : 'direct',
    GroupSystemPrompt: assembled.systemPrompt,
    SenderId: envelope.senderId,
    SenderName: envelope.senderName,
    Provider: 'qqbot',
    Surface: 'qqbot',
    MessageSid: envelope.messageId,
    Timestamp: Date.now(),
    OriginatingChannel: 'qqbot',
    OriginatingTo: envelope.targetId,
    CommandAuthorized: false,
  };

  // 通过 turn.run 分发消息给 AI（对标内置版 outbound-dispatch.ts）
  await channel.turn.run({
    channel: 'qqbot',
    accountId: route.accountId,
    raw: envelope,
    adapter: {
      ingest: () => ({
        id: envelope.messageId,
        rawText: assembled.rawBody,
        textForAgent: assembled.agentBody,
        textForCommands: assembled.rawBody,
        raw: envelope,
      }),
      resolveTurn: () => ({
        channel: 'qqbot',
        accountId: route.accountId,
        routeSessionKey: route.sessionKey,
        storePath,
        ctxPayload,
        recordInboundSession: channel.session?.recordInboundSession,
        record: {
          onRecordError: (err: unknown) => {
            log?.error(`[qqbot:${account.accountId}] Session record error: ${err}`);
          },
        },
        runDispatch: () =>
          channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              deliver: async (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }, _info: { kind: string }) => {
                const text = payload.text?.trim();

                // 处理媒体标签（<qqvoice>, <qqvideo>, <qqfile> 等）
                if (text && hasMediaTags(text)) {
                  const { tags, cleanText } = extractMediaTags(text);
                  // 先发送各媒体标签
                  for (const tag of tags) {
                    const mediaKind = mapTagToMediaKind(tag.tag);
                    await sendMedia({
                      to: qualifiedTarget,
                      text: '',
                      mediaUrl: tag.source,
                      mediaKind,
                      accountId: account.accountId,
                      replyToId: envelope.messageId,
                      account,
                    });
                  }
                  // 发送剩余纯文本
                  if (cleanText) {
                    await sendText({
                      to: qualifiedTarget,
                      text: cleanText,
                      accountId: account.accountId,
                      replyToId: envelope.messageId,
                      account,
                    });
                  }
                  return;
                }

                if (payload.mediaUrl) {
                  await sendMedia({
                    to: qualifiedTarget,
                    text: text ?? '',
                    mediaUrl: payload.mediaUrl,
                    accountId: account.accountId,
                    replyToId: envelope.messageId,
                    account,
                  });
                } else if (text) {
                  await sendText({
                    to: qualifiedTarget,
                    text,
                    accountId: account.accountId,
                    replyToId: envelope.messageId,
                    account,
                  });
                }
              },
            },
          }),
      }),
    },
  });
}

// ── 媒体标签 → MediaKind 映射 ──

function mapTagToMediaKind(tag: MediaTagType): MediaKind {
  switch (tag) {
    case 'qqvoice':
      return 'voice';
    case 'qqvideo':
      return 'video';
    case 'qqfile':
      return 'file';
    case 'qqimg':
    case 'qqmedia':
    default:
      return 'image';
  }
}

// ── Web UI Body 渲染（通过 runtime 可选链，兼容所有 openclaw 版本） ──

function renderWebBody(
  channel: any,
  cfg: unknown,
  assembled: AssembledBody,
  msg: QQBotInboundMessage,
  isGroup: boolean,
): string {
  const reply = channel?.reply;
  if (!reply?.formatInboundEnvelope) {
    return assembled.webBody;
  }
  try {
    const envelopeOpts = reply.resolveEnvelopeFormatOptions?.(cfg);
    return reply.formatInboundEnvelope({
      channel: 'qqbot',
      from: msg.senderName ?? msg.senderId,
      timestamp: parseTimestamp(msg.timestamp),
      body: assembled.webBody,
      chatType: isGroup ? 'group' : 'direct',
      sender: { id: msg.senderId, name: msg.senderName },
      envelope: envelopeOpts,
    });
  } catch {
    return assembled.webBody;
  }
}

function parseTimestamp(ts: string | number | undefined): number {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const n = Number(ts);
    if (!Number.isNaN(n)) return n;
    const d = new Date(ts).getTime();
    if (!Number.isNaN(d)) return d;
  }
  return Date.now();
}
