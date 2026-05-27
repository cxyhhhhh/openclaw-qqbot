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
import { sendText, sendMedia } from '../outbound/outbound-service.js';

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

  // 构建框架标准 MsgContext（对标内置版 buildCtxPayload）
  const ctxPayload = channel.reply?.finalizeInboundContext?.({
    Body: envelope.content,
    BodyForAgent: envelope.content,
    RawBody: envelope.content,
    CommandBody: envelope.content,
    From: envelope.targetId,
    To: envelope.targetId,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: envelope.chatScope === 'group' ? 'group' : 'direct',
    GroupSystemPrompt: envelope.systemPrompt,
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
    Body: envelope.content,
    BodyForAgent: envelope.content,
    RawBody: envelope.content,
    CommandBody: envelope.content,
    From: envelope.targetId,
    To: envelope.targetId,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: envelope.chatScope === 'group' ? 'group' : 'direct',
    GroupSystemPrompt: envelope.systemPrompt,
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
        rawText: envelope.content,
        textForAgent: envelope.content,
        textForCommands: envelope.content,
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
