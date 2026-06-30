/**
 * 消息转发 — 入站消息 → OpenClaw AI
 *
 * 核心职责：
 * 1. 从 SDK MiddlewareContext 构建 OpenClaw 标准信封
 * 2. 通过 runtime.channel.inbound.run() 将消息交给 AI 处理
 *
 * 架构说明：
 * - runtime: 全局 PluginRuntime（register 阶段注入），提供 channel.inbound.run / channel.reply 等
 * - log: per-account 日志（从 ctx.log 透传），用于运行时日志输出
 */
import type { MiddlewareContext, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { ResolvedQQBotAccount } from '../types.js';
import type { GatewayLogSink } from '../gateway/qqbot-gateway.js';
import { buildEnvelope } from './envelope-builder.js';
import { assembleBody, type AssembledBody } from './body-assembler.js';
import { sendText, sendMedia, getGateway } from '../outbound/outbound-service.js';
import { deliverReply, ToolMediaCollector, type DeliverPayload, type DeliverInfo, type DeliverContext } from '../outbound/deliver-pipeline.js';
import { StreamingController, shouldUseStreaming } from '../outbound/streaming-controller.js';

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

  if (!channel?.inbound?.run) {
    log?.error(`[qqbot:${account.accountId}] runtime.channel.inbound.run not available`);
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

  // 构建框架标准 MsgContext
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

  // 注入 MediaPaths / MediaUrls
  const processed = ctx.state.processedAttachments as any;
  if (processed?.localMediaPaths?.length) {
    (ctxPayload as any).MediaPaths = processed.localMediaPaths;
    (ctxPayload as any).MediaPath = processed.localMediaPaths[0];
    (ctxPayload as any).MediaTypes = processed.localMediaTypes;
    (ctxPayload as any).MediaType = processed.localMediaTypes?.[0];
  }
  if (processed?.remoteMediaUrls?.length) {
    (ctxPayload as any).MediaUrls = processed.remoteMediaUrls;
    (ctxPayload as any).MediaUrl = processed.remoteMediaUrls[0];
  }

  // Tool media 收集器（跨 deliver 调用积累）
  const toolMedia = new ToolMediaCollector();

  // TTS 能力探测（从 runtime 获取）
  const ttsRuntime = (runtime as any)?.tts ?? channel?.runtimeContexts?.get?.('tts');

  // 构建 deliver context
  const deliverCtx: DeliverContext = {
    qualifiedTarget,
    accountId: account.accountId,
    replyToId: envelope.messageId,
    chatScope: envelope.chatScope === 'group' ? 'group' : 'direct',
    cfg,
    sendText: (to, text) => sendText({ to, text, accountId: account.accountId, replyToId: envelope.messageId, account }),
    sendMedia: (to, source, opts) => sendMedia({
      to,
      text: opts?.text ?? '',
      mediaUrl: source,
      mediaKind: opts?.mediaKind,
      accountId: account.accountId,
      replyToId: envelope.messageId,
      account,
    }),
    textToSpeech: ttsRuntime?.textToSpeech
      ? (params) => ttsRuntime.textToSpeech(params)
      : undefined,
    audioFileToSilkBase64: ttsRuntime?.audioFileToSilkBase64
      ? (audioPath: string) => ttsRuntime.audioFileToSilkBase64(audioPath)
      : undefined,
    log: log ? { info: log.info, error: log.error, debug: log.debug } : undefined,
  };

  // ── 流式路由：账户开启 streaming + C2C 时启用 ──
  const streamingEnabled = shouldUseStreaming(
    account,
    envelope.chatScope === 'group' ? 'group' : 'c2c',
  );

  const streamingController = streamingEnabled
    ? createStreamingController(envelope, account, log)
    : null;

  if (streamingController) {
    log?.info(`[qqbot:${account.accountId}] streaming enabled for ${envelope.senderId}`);
  }

  // 通过 channel.inbound.run 分发消息给 AI
  await channel.inbound.run({
    channel: 'qqbot',
    accountId: route.accountId,
    raw: envelope,
    adapter: {
      ingest: (raw: any) => ({
        id: envelope.messageId,
        rawText: assembled.rawBody,
        textForAgent: assembled.agentBody,
        textForCommands: assembled.rawBody,
        raw,
      }),
      resolveTurn: (_input: unknown, _eventClass: unknown, _preflight: unknown) => ({
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
        runDispatch: () => {
          return channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              deliver: async (payload: DeliverPayload, info?: DeliverInfo) => {
                // 流式启用且尚未降级 → 由 onPartialReply 驱动；deliver 仅用于 finalize / 降级 fallback
                if (streamingController && !streamingController.shouldFallbackToStatic) {
                  await streamingController.finalize(payload.text);
                  if (!streamingController.shouldFallbackToStatic) {
                    return; // 流式正常完成，无需走 deliver pipeline
                  }
                  log?.warn(`[qqbot:${account.accountId}] streaming fallback to static deliver`);
                }
                await deliverReply(payload, info, deliverCtx, toolMedia);
              },
            },
            replyOptions: streamingController
              ? {
                  onPartialReply: async (p: { text?: string }) => {
                    if (p.text) await streamingController.onPartialReply(p.text);
                  },
                }
              : undefined,
          });
        },
      }),
    },
  });

  // 终态保护：如果 deliver 从未被调用（罕见，但模型可能直接结束），主动 finalize
  if (streamingController && !streamingController.isTerminal) {
    await streamingController.finalize();
  }
}

// ── 流式控制器工厂 ──

function createStreamingController(
  envelope: ReturnType<typeof buildEnvelope>,
  account: ResolvedQQBotAccount,
  log?: GatewayLogSink,
): StreamingController | null {
  const gw = getGateway(account.accountId);
  if (!gw) {
    log?.error(`[qqbot:${account.accountId}] cannot enable streaming — gateway not running`);
    return null;
  }
  return new StreamingController({
    gateway: gw,
    target: {
      scope: 'c2c',
      targetId: envelope.senderId,
      msgId: envelope.messageId,
    },
    accountId: account.accountId,
    replyToId: envelope.messageId,
    log,
  });
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
