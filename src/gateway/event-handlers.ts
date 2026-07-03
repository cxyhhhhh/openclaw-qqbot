/**
 * QQBotGateway 事件处理
 *
 * 处理 SDK 的 message / interaction 事件：
 * - message: 中间件处理完毕后，将消息转发到 OpenClaw AI
 * - interaction: 路由到审批处理器
 *
 * 注意：并发控制（串行+合并）由 concurrencyGuard 中间件处理，
 * 此处只负责单条消息的 dispatch。
 */
import type { MiddlewareContext, QQBotInboundMessage, InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import { dispatchToOpenClaw } from '../dispatch/index.js';
import { runWithRequestContext } from '../request-context.js';
import { getApprovalHandler } from '../features/approval-handler.js';
import { recordKnownUser } from '../features/proactive.js';

export async function handleMessage(
  ctx: MiddlewareContext,
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
): Promise<void> {
  const hlog = log.child('handle');
  const scope = msg.replyTarget.scope;
  const targetId = scope === 'group'
    ? `qqbot:group:${msg.replyTarget.targetId}`
    : `qqbot:c2c:${msg.replyTarget.targetId}`;

  const mergedCount = (ctx.state.mergedMessages as unknown[] | undefined)?.length;
  if (mergedCount) {
    hlog.info(`merged batch count=${mergedCount} msgId=${msg.messageId}`);
  } else {
    hlog.debug(`enter msgId=${msg.messageId} scope=${scope} contentLen=${(msg.content ?? '').length}`);
  }

  try {
    recordKnownUser({
      type: scope === 'group' ? 'group' : 'c2c',
      openid: scope === 'group' ? msg.replyTarget.targetId : msg.senderId,
      accountId: account.accountId,
      nickname: msg.senderName,
      lastInteractionAt: Date.now(),
    });
  } catch {
    // 非关键，静默忽略
  }

  await runWithRequestContext(
    {
      target: targetId,
      accountId: account.accountId,
      messageId: msg.messageId,
      openId: msg.senderId,
    },
    () => dispatchToOpenClaw(ctx, msg, account, runtime, log),
  );
  hlog.debug(`done msgId=${msg.messageId}`);
}

export async function handleInteraction(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  _runtime: PluginRuntime,
  log: PluginLogger,
  acknowledgeInteraction: (interactionId: string) => Promise<void>,
): Promise<void> {
  try {
    await acknowledgeInteraction(event.id);
  } catch {
    // ACK 失败不影响后续处理
  }

  const buttonData = event.data?.resolved?.button_data;
  if (!buttonData || !buttonData.startsWith('approve:')) {
    if (buttonData) log.debug(`handleInteraction: non-approve button data=${buttonData}`);
    return;
  }

  const parts = buttonData.split(':');
  if (parts.length < 3) {
    log.warn(`handleInteraction: malformed button data=${buttonData}`);
    return;
  }

  const handler = getApprovalHandler(account.accountId);
  if (!handler) {
    log.warn(`handleInteraction: no approval handler for account=${account.accountId}`);
    return;
  }

  const approvalId = parts[1];
  const decision = parts[2] as 'allow-once' | 'allow-always' | 'deny';

  log.debug(`handleInteraction: resolving approval id=${approvalId} decision=${decision}`);

  try {
    const ok = await handler.resolveApproval(approvalId, decision);
    log.debug(`handleInteraction: resolve result=${ok} id=${approvalId}`);
  } catch (err) {
    log.error(`handleInteraction: resolve error id=${approvalId}: ${err}`);
  }
}
