/**
 * 消息转发 — 入站消息 → OpenClaw AI
 *
 * 核心职责：
 * 1. 从 SDK MiddlewareContext 构建 OpenClaw 标准信封
 * 2. 通过 runtime-adapter 将消息交给 AI 处理
 *
 * 架构说明：
 * - 所有 runtime.channel.* 访问均通过 runtime-adapter 隔离
 * - log: 前缀由 PluginLogger + 框架自动注入，消息体不重复 accountId
 */
import type { MiddlewareContext, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import { buildEnvelope } from './envelope-builder.js';
import { assembleBody, type AssembledBody } from './body-assembler.js';
import { sendText, sendMedia, getGateway } from '../outbound/outbound-service.js';
import { deliverReply, type DeliverPayload, type DeliverInfo, type DeliverContext } from '../outbound/deliver-pipeline.js';
import { DeliverDebouncer } from '../outbound/debounce.js';
import { StreamingController, shouldUseStreaming } from '../outbound/streaming-controller.js';
import { getAdapters } from '../runtime-adapter/resolve.js';
import { clearGroupHistory } from '../features/history-store.js';

/**
 * 将经过中间件处理的入站消息转发给 OpenClaw AI
 */
export async function dispatchToOpenClaw(
  ctx: MiddlewareContext,
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log?: PluginLogger,
): Promise<void> {
  const dlog = log?.child('dispatch');
  const adapters = getAdapters(runtime, dlog);
  const envelope = buildEnvelope(ctx, msg, account);

  dlog?.debug(`received sender=${envelope.senderId} scope=${envelope.chatScope} msgId=${envelope.messageId}`);

  if (!adapters.inboundRun) {
    dlog?.error(`runtime adapter inboundRun not available (openclaw=${adapters.version})`);
    return;
  }

  if (!adapters.dispatchReply) {
    dlog?.error(`runtime adapter dispatchReply not available (openclaw=${adapters.version})`);
    return;
  }

  const assembled: AssembledBody =
    ((ctx.state as Record<string, unknown>).assembledBody as AssembledBody | undefined) ??
    assembleBody(ctx, msg, account);

  const cfg = adapters.getConfig?.() ?? {};

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
      body: assembled.webBody,
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

  const ttsRuntime = (runtime as any)?.tts ?? (runtime as any)?.channel?.runtimeContexts?.get?.('tts');

  const debounceConfig = account.config?.deliverDebounce;
  const debouncer = debounceConfig?.enabled !== false
    ? new DeliverDebouncer(debounceConfig, (targetId, mergedText) =>
        sendText({ to: targetId, text: mergedText, accountId: account.accountId, replyToId: envelope.messageId, account }).then(() => {}),
      )
    : undefined;

  const deliverCtx: DeliverContext = {
    qualifiedTarget,
    accountId: account.accountId,
    replyToId: envelope.messageId,
    chatScope: envelope.chatScope === 'group' ? 'group' : 'direct',
    cfg,
    debouncer: debouncer?.enabled ? debouncer : undefined,
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
    log: log?.child('deliver'),
  };

  const streamingEnabled = shouldUseStreaming(
    account,
    envelope.chatScope === 'group' ? 'group' : 'c2c',
  );

  const streamingController = streamingEnabled
    ? createStreamingController(envelope, account, log?.child('streaming'))
    : null;

  if (streamingController) {
    dlog?.debug(`streaming enabled for ${envelope.senderId}`);
  }

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
            dlog?.error(`Session record error: ${err}`);
          },
        },
        runDispatch: () => {
          let blockDelivered = false;
          return adapters.dispatchReply!({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              deliver: async (payload: DeliverPayload, info?: DeliverInfo) => {
                try {
                  const kind = (info as any)?.kind as string | undefined;
                  if (streamingController && !streamingController.shouldFallbackToStatic) {
                    await streamingController.finalize(payload.text);
                    if (!streamingController.shouldFallbackToStatic) {
                      return;
                    }
                    dlog?.warn(`streaming fallback to static`);
                  }

                  if (kind === 'block') {
                    blockDelivered = true;
                  } else if (kind === 'final' && blockDelivered) {
                    return;
                  }

                  await deliverReply(payload, info, deliverCtx);
                } catch (err) {
                  dlog?.error(`error: ${err instanceof Error ? err.message : String(err)}`);
                }
              },
            },
            replyOptions: {
              runId: envelope.messageId,
              ...(streamingController
                ? {
                    onPartialReply: async (p: { text?: string }) => {
                      if (p.text) await streamingController.onPartialReply(p.text);
                    },
                  }
                : {}),
            },
          });
        },
      }),
    },
  });

  dlog?.debug(`inboundRun completed sessionKey=${route.sessionKey}`);

  // 群消息回复后清空历史缓存（避免下次 @ 时重复组包）
  if (envelope.chatScope === 'group') {
    clearGroupHistory(envelope.groupId ?? envelope.senderId);
  }

  if (streamingController && !streamingController.isTerminal) {
    await streamingController.finalize();
  }

  if (debouncer) {
    await debouncer.flushAll();
  }
}

function createStreamingController(
  envelope: ReturnType<typeof buildEnvelope>,
  account: ResolvedQQBotAccount,
  log?: PluginLogger,
): StreamingController | null {
  const gw = getGateway(account.accountId);
  if (!gw) {
    log?.error(`cannot enable streaming — gateway not running`);
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


