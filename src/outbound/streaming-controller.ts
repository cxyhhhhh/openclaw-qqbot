/**
 * QQ Bot 流式消息控制器
 *
 * 职责（业务层）：
 *   1. 回复边界检测：基于原始文本前缀匹配，发现新消息时拼 "\n\n" 续上
 *   2. 降级判断：从未成功发出过任何分片 → fallback 为静态消息
 *
 * SDK `StreamSession` 已经处理：
 *   - throttle / debounce
 *   - msg_seq / index / stream_msg_id 维护
 *   - 429 / 50002 重试退避
 *   - 替换语义（每次 update 是全量文本）
 *
 * 输入侧由 `replyOptions.onPartialReply({ text })` 驱动，每次 text 是**全量**。
 */

import type { ReplyTarget, StreamSession } from '@tencent-connect/qqbot-nodejs';
import type { PluginLogger } from '../utils/plugin-logger.js';
import type { QQBotGateway } from '../gateway/qqbot-gateway.js';

// ── 类型 ──

export type StreamingPhase = 'idle' | 'streaming' | 'completed' | 'aborted';

export interface StreamingControllerDeps {
  /** 已注册的 QQBot Gateway（提供 openStream） */
  gateway: QQBotGateway;
  /** 流式目标（必须是 c2c） */
  target: ReplyTarget;
  /** 账户 ID */
  accountId: string;
  /** 用于被动回复的入站消息 ID */
  replyToId: string;
  /** 日志 */
  log?: PluginLogger;
  /** 节流毫秒（透传给 SDK StreamSession） */
  throttleMs?: number;
}

// ── 控制器 ──

/**
 * 流式控制器
 *
 * 通过 `onPartialReply(text)` 持续接收全量文本，
 * 通过 `finalize()` 标记终结，
 * 通过 `abort()` 中止。
 */
export class StreamingController {
  private phase: StreamingPhase = 'idle';
  private session: StreamSession | null = null;

  /** 最后一次收到的原始文本（用于边界检测） */
  private lastRawFull = '';
  /** 边界拼接前缀（检测到新回复时使用） */
  private boundaryPrefix: string | null = null;

  /** 已成功发送的流式分片计数（用于降级判断） */
  private sentChunkCount = 0;

  /** 串行队列：所有 onPartialReply / finalize 经此排队执行 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: StreamingControllerDeps) {}

  // ── 公共访问器 ──

  get currentPhase(): StreamingPhase {
    return this.phase;
  }

  get isTerminal(): boolean {
    return this.phase === 'completed' || this.phase === 'aborted';
  }

  /**
   * 是否应降级到静态消息：终态 + 从未成功发出任何分片。
   * 上层在 finalize 后据此判断是否走 `sendText` 兜底。
   */
  get shouldFallbackToStatic(): boolean {
    return this.isTerminal && this.sentChunkCount === 0;
  }

  // ── 主入口 ──

  /**
   * 处理一次 onPartialReply 回调（全量文本）
   */
  onPartialReply(text: string): Promise<void> {
    this.chain = this.chain.then(() => this.doPartialReply(text)).catch((err) => {
      this.logError(`onPartialReply error: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.chain as Promise<void>;
  }

  /**
   * 标记流式完成 — 终结当前会话或转入降级判断。
   */
  finalize(finalText?: string): Promise<void> {
    this.chain = this.chain.then(() => this.doFinalize(finalText)).catch((err) => {
      this.logError(`finalize error: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.chain as Promise<void>;
  }

  /**
   * 显式中止 — 用于上游 abort 信号触发
   */
  async abort(reason?: string): Promise<void> {
    if (this.isTerminal) return;
    this.transitionTo('aborted', `abort: ${reason ?? 'manual'}`);
    if (this.session) {
      try {
        await this.session.complete();
      } catch (err) {
        this.logError(`abort complete failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.session = null;
    }
  }

  // ── 内部：onPartialReply 串行体 ──

  private async doPartialReply(text: string): Promise<void> {
    if (this.isTerminal) return;
    if (!text) return;

    // 边界拼接：若已发生过边界，自动加前缀
    const fullText = this.boundaryPrefix !== null ? this.boundaryPrefix + text : text;

    // 回复边界检测（用原始文本前缀匹配）
    if (this.lastRawFull && fullText.length > 0 && !fullText.startsWith(this.lastRawFull)) {
      this.logInfo(
        `reply boundary detected: prev=${this.lastRawFull.length} new=${fullText.length}`,
      );
      this.boundaryPrefix = this.lastRawFull + '\n\n';
      const merged = this.boundaryPrefix + text;
      this.lastRawFull = merged;
      await this.ensureSessionWith(merged);
    } else {
      this.lastRawFull = fullText;
      await this.ensureSessionWith(fullText);
    }
  }

  // ── 内部：finalize 串行体 ──

  private async doFinalize(finalText?: string): Promise<void> {
    if (this.isTerminal) return;

    // 若有 finalText，做最后一次 update
    if (finalText) {
      const fullText = this.boundaryPrefix !== null ? this.boundaryPrefix + finalText : finalText;
      if (fullText !== this.lastRawFull) {
        this.lastRawFull = fullText;
        await this.ensureSessionWith(fullText);
      }
    }

    // 终结当前流式会话
    if (this.session) {
      try {
        await this.session.complete();
        this.session = null;
        this.transitionTo('completed', 'finalize:done');
        return;
      } catch (err) {
        this.logError(`finalize complete failed: ${err instanceof Error ? err.message : String(err)}`);
        this.transitionTo('aborted', 'finalize:complete_error');
        return;
      }
    }

    // 没有活跃会话 — 视有无已发内容决定终态
    if (this.sentChunkCount > 0) {
      this.transitionTo('completed', 'finalize:no_session_but_sent');
    } else {
      this.logInfo('no chunks sent, falling back to static');
      this.transitionTo('aborted', 'finalize:fallback_to_static');
    }
  }

  // ── 内部：StreamSession 管理 ──

  /**
   * 确保 StreamSession 已打开，并把 text 推给它（SDK 内部节流）。
   * SDK 使用 replace 语义 — 每次传入的是**当前会话内的完整文本**。
   */
  private async ensureSessionWith(text: string): Promise<void> {
    if (!this.session) {
      this.session = this.deps.gateway.openStream(this.deps.target, this.deps.replyToId);
      this.transitionTo('streaming', 'first_chunk');
    }
    try {
      await this.session.update(text);
      this.sentChunkCount += 1;
    } catch (err) {
      this.logError(`stream update failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  // ── 内部：状态机 ──

  private transitionTo(next: StreamingPhase, reason: string): void {
    if (this.phase === next) return;
    this.logInfo(`phase: ${this.phase} → ${next} (${reason})`);
    this.phase = next;
  }

  // ── 日志 ──

  private logInfo(msg: string): void {
    this.deps.log?.info(`[qqbot:streaming] ${msg}`);
  }

  private logError(msg: string): void {
    this.deps.log?.error(`[qqbot:streaming] ${msg}`);
  }
}

// ── 路由判断 ──

import type { ResolvedQQBotAccount } from '../types.js';

/**
 * 判断当前消息是否应使用流式模式：
 *  1. 账户开启 streaming
 *  2. 目标是 C2C（QQ 流式 API 仅支持私聊）
 */
export function shouldUseStreaming(
  account: ResolvedQQBotAccount,
  targetScope: 'c2c' | 'group' | 'channel',
): boolean {
  if (targetScope !== 'c2c') return false;
  return account.config?.streaming === true;
}
