/**
 * 消息转发 — 入站消息 → OpenClaw AI
 *
 * 核心职责：
 * 1. 从 SDK MiddlewareContext 构建 OpenClaw 标准信封
 * 2. 通过 runtime-adapter 将消息交给 AI 处理
 *
 * 架构说明：
 * - 所有 runtime.channel.* 访问均通过 runtime-adapter 隔离
 * - log: per-account 日志（从 ctx.log 透传）
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
import { resolveRuntimeAdapters, type RuntimeAdapters } from '../runtime-adapter/resolve.js';

// ── 缓存 resolved adapters（per-runtime instance） ──
let cachedAdapters: RuntimeAdapters | null = null;
let cachedRuntime: PluginRuntime | null = null;

function getAdapters(runtime: PluginRuntime, log?: GatewayLogSink): RuntimeAdapters {
  if (cachedRuntime === runtime && cachedAdapters) return cachedAdapters;
  cachedAdapters = resolveRuntimeAdapters(runtime, log);
  cachedRuntime = runtime;
  return cachedAdapters;
}

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
  const adapters = getAdapters(runtime, log);
  const envelope = buildEnvelope(ctx, msg, account);

  // ── Guard: 必需 API 不可用 → 仅记录错误日志 ──
  if (!adapters.inboundRun) {
    log?.error(`[qqbot:${account.accountId}] runtime adapter inboundRun not available (openclaw=${adapters.version})`);
    return;
  }

  if (!adapters.dispatchReply) {
    log?.error(`[qqbot:${account.accountId}] runtime adapter dispatchReply not available (openclaw=${adapters.version})`);
    return;
  }

  // 优先使用 envelopeFormatter 中间件缓存的组装结果，fallback 即时组装
  const assembled: AssembledBody =
    ((ctx.state as Record<string, unknown>).assembledBody as AssembledBody | undefined) ??
    assembleBody(ctx, msg, account);

  const cfg = adapters.getConfig?.() ?? {};

  // 解析路由（可选 — 降级为默认路由）
  const route = adapters.resolveAgentRoute?.({
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
  const storePath = adapters.resolveStorePath?.((cfg as any)?.session?.store, { agentId }) ?? '';

  // Web UI Body 渲染
  const isGroup = envelope.chatScope === 'group';
  const webBody = renderWebBody(adapters, cfg, assembled, msg, isGroup);

  // 构建框架标准 MsgContext（adapter 层已适配新旧 API，业务代码无需感知版本）
  const ctxPayload = adapters.buildInboundContext?.({
    channel: 'qqbot',
    accountId: route.accountId,
    provider: 'qqbot',
    surface: 'qqbot',
    messageId: envelope.messageId,
    timestamp: Date.now(),
    from: envelope.targetId,
    sender: { id: envelope.senderId, name: envelope.senderName },
    conversation: {
      kind: envelope.chatScope === 'group' ? 'group' : 'direct',
      label: assembled.systemPrompt,
    },
    message: {
      body: webBody,
      bodyForAgent: assembled.agentBody,
      rawBody: assembled.rawBody,
      commandBody: assembled.rawBody,
    },
    route: {
      routeSessionKey: route.sessionKey,
      accountId: route.accountId,
    },
    reply: {
      to: envelope.targetId,
      replyToId: envelope.messageId,
      originatingTo: envelope.targetId,
    },
  });

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

  // TTS 能力探测
  const ttsRuntime = (runtime as any)?.tts ?? (runtime as any)?.channel?.runtimeContexts?.get?.('tts'); // @adapter-bypass: TTS 是插件扩展点，非核心 channel API

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

  // ── 通过 adapters.inboundRun 分发消息给 AI ──
  await adapters.inboundRun({
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
        recordInboundSession: adapters.recordInboundSession,
        record: {
          onRecordError: (err: unknown) => {
            log?.error(`[qqbot:${account.accountId}] Session record error: ${err}`);
          },
        },
        runDispatch: () => {
          return adapters.dispatchReply!({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              deliver: async (payload: DeliverPayload, info?: DeliverInfo) => {
                if (streamingController && !streamingController.shouldFallbackToStatic) {
                  await streamingController.finalize(payload.text);
                  if (!streamingController.shouldFallbackToStatic) {
                    return;
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

  // 终态保护
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

// ── Web UI Body 渲染 ──

function renderWebBody(
  adapters: RuntimeAdapters,
  cfg: unknown,
  assembled: AssembledBody,
  msg: QQBotInboundMessage,
  isGroup: boolean,
): string {
  if (!adapters.formatEnvelope) return assembled.webBody;
  try {
    const envelopeOpts = adapters.resolveEnvelopeFormatOptions?.(cfg);
    return adapters.formatEnvelope({
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
