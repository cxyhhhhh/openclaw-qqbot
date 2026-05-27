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
import type { GatewayLogSink } from './qqbot-gateway.js';
import { dispatchToOpenClaw } from '../dispatch/index.js';
import { runWithRequestContext } from '../request-context.js';
import { getApprovalHandler } from '../features/approval-handler.js';
import { recordKnownUser } from '../features/proactive.js';

/**
 * 处理入站消息事件
 *
 * 在 AsyncLocalStorage 作用域中执行，确保 tools（如 remind）
 * 能通过 getRequestTarget() 获取当前会话上下文。
 */
export async function handleMessage(
  ctx: MiddlewareContext,
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log?: GatewayLogSink,
): Promise<void> {
  const scope = msg.replyTarget.scope;
  const targetId = scope === 'group'
    ? `qqbot:group:${msg.replyTarget.targetId}`
    : `qqbot:c2c:${msg.replyTarget.targetId}`;

  // 记录已知用户（供主动消息使用）
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
    { target: targetId, accountId: account.accountId },
    () => dispatchToOpenClaw(ctx, msg, account, runtime, log),
  );
}

/**
 * 处理交互事件（Inline Keyboard 按钮点击等）
 */
export async function handleInteraction(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  _runtime: PluginRuntime,
  acknowledgeInteraction: (interactionId: string) => Promise<void>,
): Promise<void> {
  // 先 ACK 交互防止超时
  try {
    await acknowledgeInteraction(event.id);
  } catch {
    // ACK 失败不影响后续处理
  }

  // 解析审批按钮数据：格式 "approve:{approvalId}:{decision}"
  const buttonData = event.data?.resolved?.button_data;
  if (!buttonData || !buttonData.startsWith('approve:')) return;

  const handler = getApprovalHandler(account.accountId);
  if (!handler) return;

  const parts = buttonData.split(':');
  // parts = ["approve", approvalId, decision]
  if (parts.length < 3) return;

  const approvalId = parts[1];
  const decision = parts[2] as 'allow-once' | 'allow-always' | 'deny';

  try {
    await handler.resolveApproval(approvalId, decision);
  } catch (err) {
    console.error(`[qqbot:${account.accountId}] Approval resolve error:`, err);
  }
}
