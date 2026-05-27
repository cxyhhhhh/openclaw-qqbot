/**
 * 流式消息转发
 *
 * 当 C2C 场景启用流式时，使用 SDK 的 StreamSession 实现打字机效果。
 *
 * 注意：流式消息仅 QQ C2C（私聊）支持。群聊场景自动降级为普通模式。
 * 当框架 runtime 不提供流式 dispatch API 时同样降级。
 */
import type { ReplyTarget } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { OpenClawInboundMessage } from './envelope-builder.js';
import type { ResolvedQQBotAccount } from '../types.js';
import type { GatewayLogSink } from '../gateway/qqbot-gateway.js';
import { getGateway } from '../outbound/outbound-service.js';

/**
 * 以流式方式将 AI 回复投递到 QQ（C2C only）
 *
 * @returns true 如果成功走了流式路径，false 表示降级
 */
export async function dispatchStreaming(
  envelope: OpenClawInboundMessage,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log?: GatewayLogSink,
): Promise<boolean> {
  const gw = getGateway(account.accountId);
  if (!gw) {
    log?.error(`[qqbot:${account.accountId}] Bot not running, cannot stream`);
    return false;
  }

  const channel = runtime.channel as any;

  // 检查框架是否支持流式 dispatch
  if (!channel?.reply?.dispatchReplyWithStreamingDispatcher) {
    return false; // 降级到普通模式
  }

  const target: ReplyTarget = {
    scope: 'c2c',
    targetId: envelope.senderId,
    msgId: envelope.messageId,
  };

  const stream = gw.openStream(target, envelope.messageId);

  try {
    await channel.reply.dispatchReplyWithStreamingDispatcher({
      ctx: envelope,
      onChunk: async (text: string) => {
        await stream.update(text);
      },
      onEnd: async () => {
        await stream.complete();
      },
    });
    return true;
  } catch (err) {
    try { await stream.complete(); } catch { /* ignore */ }
    log?.error(`[qqbot:${account.accountId}] Streaming error: ${err}`);
    return false;
  }
}
