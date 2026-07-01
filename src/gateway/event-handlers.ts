/**
 * QQBotGateway 事件处理
 *
 * 处理 SDK 的 message / interaction 事件：
 * - message: 中间件处理完毕后，将消息转发到 OpenClaw AI
 * - interaction: 路由到审批处理器
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
  const scope = msg.replyTarget.scope;
  const targetId = scope === 'group'
    ? `qqbot:group:${msg.replyTarget.targetId}`
    : `qqbot:c2c:${msg.replyTarget.targetId}`;

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
  if (!buttonData || !buttonData.startsWith('approve:')) return;

  const handler = getApprovalHandler(account.accountId);
  if (!handler) return;

  const parts = buttonData.split(':');
  if (parts.length < 3) return;

  const approvalId = parts[1];
  const decision = parts[2] as 'allow-once' | 'allow-always' | 'deny';

  try {
    await handler.resolveApproval(approvalId, decision);
  } catch (err) {
    log.error(`Approval resolve error: ${err}`);
  }
}
