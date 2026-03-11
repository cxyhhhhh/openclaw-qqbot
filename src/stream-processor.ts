/**
 * QQ Bot 流式消息处理器
 *
 * 参照 logic/stream_processor.go 实现，提供：
 * - 攒包缓冲区：token 级别的增量内容累积到 partialMsg，由定时器驱动发送
 * - 智能切分：通过 SplitMsg 在安全位置（换行、括号平衡点）切断，避免 Markdown 语法结构被拆开
 * - 变速发送：前期快速（200ms）→ 后期常规（500ms），加速首屏体验
 * - 字节阈值：缓冲区超过阈值时立即发送，避免长时间不发
 * - 空白保活：长时间无内容时发空白分片，保持流式会话不超时
 * - 中断支持：收到新消息时优雅中断，发送 ForceEnd 分片
 */

import { splitMsg, SplitMsgError } from "./split-msg.js";

/** 流式消息状态（参照 logic StreamState） */
export enum StreamState {
  /** 正文生成中 */
  TextGenerating = 1,
  /** 推荐回复生成中 */
  PromptGen = 3,
  /** 正文生成结束 */
  TextEnd = 10,
}

/** 流式消息分片 */
export interface StreamChunk {
  /** 分片内容（markdown content） */
  content: string;
  /** 流式状态 */
  state: StreamState;
  /** 流式序号（递增） */
  streamIndex: number;
  /** 是否首个分片 */
  isFirst: boolean;
  /** 是否最后分片 */
  isLast: boolean;
}

/** 发送分片回调 */
export type SendChunkCallback = (chunk: StreamChunk) => Promise<void>;

/** 完成回调 */
export type FinishCallback = (fullContent: string) => Promise<void>;

/** 流式处理器配置 */
export interface StreamProcessorConfig {
  /** 首包快速发送间隔（ms），默认 200 */
  firstSendInterval?: number;
  /** 常规发送间隔（ms），默认 500 */
  sendInterval?: number;
  /** 快速发送次数，达到后切换为常规间隔，默认 10 */
  fastSendCount?: number;
  /** 字节阈值，缓冲区超过此值立即发送，默认 500 */
  sendBytesThreshold?: number;
  /** 空白保活间隔（ms），默认 3000 */
  blankSendInterval?: number;
  /**
   * 全局节流间隔（ms），控制 API 调用频率上限，默认 1000
   * 参考 Telegram 的 throttleMs，防止过于频繁地调用平台 API
   */
  throttleMs?: number;
  /**
   * 首次发送最小字符数，默认 30
   * 首次发送至少积累此数量字符后才触发（优化推送通知体验）
   */
  minInitialChars?: number;
  /**
   * 单分片最小字符数，默认 20
   * splitMsg 切分后若内容少于此值则不发送，继续攒到下次 tick
   * 避免每个 API 调用只推几个字符，浪费请求
   */
  minChunkChars?: number;
  /**
   * 单条流式消息最大字符数，默认 4096
   * 超过此限制后停止流式发送，避免平台 API 报错
   */
  maxChars?: number;
  /** 日志前缀 */
  logPrefix?: string;
}

const DEFAULT_CONFIG: Required<StreamProcessorConfig> = {
  firstSendInterval: 200,
  sendInterval: 500,
  fastSendCount: 10,
  sendBytesThreshold: 500,
  blankSendInterval: 3000,
  throttleMs: 1000,
  minInitialChars: 30,
  minChunkChars: 20,
  maxChars: 4096,
  logPrefix: "[stream-processor]",
};

/**
 * StreamProcessor 流式消息处理器
 *
 * 使用方式：
 * 1. new StreamProcessor(sendCb, finishCb, config)
 * 2. processor.startSendLoop() — 启动攒包定时器
 * 3. processor.appendContent(text) — 模型每产出 token 调用
 * 4. processor.finish() — 模型回复结束时调用
 */
export class StreamProcessor {
  private partialMsg = "";       // 待发送的累积内容
  private fullContent = "";      // 完整消息内容
  private lastSendTime = Date.now();

  private streamSeq = 0;         // stream 序号
  private hasSentFirst = false;  // 是否已发送第一个分片
  private isFinished = false;    // 是否已结束
  private forceEnd = false;      // 是否强制结束
  private interrupted = false;   // 是否被中断
  private maxCharsStopped = false; // 是否因 maxChars 超限而停止

  private sendErr: Error | null = null; // 发送错误

  /** 串行化发送队列：确保分片按序发送，避免并发导致 stream.id 竞态 */
  private sendQueue: Promise<void> = Promise.resolve();

  /** 队列中待发送的分片数（用于入队限流，防止 API 慢时队列无限堆积） */
  private queueDepth = 0;

  private sendCount = 0; // 已发送分片次数

  // 定时器
  private tickerTimer: ReturnType<typeof setInterval> | null = null;
  private blankTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly sendCallback: SendChunkCallback;
  private readonly finishCallback: FinishCallback | null;
  private readonly config: Required<StreamProcessorConfig>;

  private log: (...args: unknown[]) => void;

  constructor(
    sendCb: SendChunkCallback,
    finishCb: FinishCallback | null,
    config?: StreamProcessorConfig,
  ) {
    this.sendCallback = sendCb;
    this.finishCallback = finishCb;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.log = (...args: unknown[]) =>
      console.log(this.config.logPrefix, ...args);
  }

  // ===================== 公共 API =====================

  /**
   * 启动发送定时器循环
   * 参照 logic StartSendLoop + sendTickLoop
   */
  startSendLoop(): void {
    // 初始使用快速间隔
    this.tickerTimer = setInterval(() => {
      this.tickerTrySend();
    }, this.config.firstSendInterval);

    // 空白保活定时器
    this.resetBlankTimer();
  }

  /**
   * 追加正文内容（每个 token delta 调用一次）
   */
  appendContent(content: string): void {
    if (this.isFinished || this.interrupted || this.sendErr || this.maxCharsStopped) return;

    // maxChars 截断：超过限制后停止接收新内容
    const remaining = this.config.maxChars - this.fullContent.length;
    if (remaining <= 0) {
      this.maxCharsStopped = true;
      this.log(`Stream stopped: maxChars limit reached (${this.config.maxChars})`);
      return;
    }

    const truncated = content.length > remaining ? content.slice(0, remaining) : content;
    this.partialMsg += truncated;
    this.fullContent += truncated;

    if (truncated.length < content.length) {
      this.maxCharsStopped = true;
      this.log(`Stream stopped: maxChars limit reached (${this.config.maxChars}), content truncated`);
    }

    // 字节阈值检查
    if (this.partialMsg.length > this.config.sendBytesThreshold) {
      this.flushBuffered();
    }
  }

  /**
   * 完成处理，发送最后分片
   * 参照 logic Finish
   */
  async finish(): Promise<void> {
    if (this.isFinished) return;
    this.isFinished = true;

    // 停止定时器
    this.stopTimers();

    // 如果之前发送失败，跳过 flush（内容不完整）
    // 必须 await，确保最后的内容分片发送完成、streamID 已获取后再发结束分片
    if (!this.sendErr) {
      await this.flushBufferedAsync();
    }

    // 发送结束分片
    const chunk: StreamChunk = {
      content: "",
      state: StreamState.TextEnd,
      streamIndex: this.streamSeq++,
      isFirst: !this.hasSentFirst,
      isLast: true,
    };

    try {
      await this.sendCallback(chunk);
    } catch (err) {
      this.log("send last chunk failed:", err);
    }

    // 完成回调
    if (this.finishCallback) {
      try {
        await this.finishCallback(this.fullContent);
      } catch (err) {
        this.log("finish callback failed:", err);
      }
    }

    this.log(
      `Stream finished, total content length: ${this.fullContent.length}, forceEnd: ${this.forceEnd}, maxCharsStopped: ${this.maxCharsStopped}`,
    );
  }

  /**
   * 强制结束：设置 forceEnd 标记并调用 finish
   * 参照 logic ForceEnd
   */
  async forceFinish(): Promise<void> {
    this.forceEnd = true;
    await this.finish();
  }

  /**
   * 中断：标记中断，停止接收后续内容
   * 参照 logic Interrupt
   */
  interrupt(): void {
    this.interrupted = true;
  }

  /** 是否已被中断 */
  isInterrupted(): boolean {
    return this.interrupted;
  }

  /** 是否有发送错误 */
  hasSendErr(): boolean {
    return this.sendErr !== null;
  }

  /** 是否已发送有效内容 */
  hasSentContent(): boolean {
    return this.hasSentFirst;
  }

  /** 获取完整内容 */
  getFullContent(): string {
    return this.fullContent;
  }

  /** 是否因 maxChars 超限而停止 */
  isMaxCharsStopped(): boolean {
    return this.maxCharsStopped;
  }

  // ===================== 内部逻辑 =====================

  /** 构建分片并标记 hasSentFirst */
  private makeChunk(content: string, state: StreamState = StreamState.TextGenerating, isLast = false): StreamChunk {
    const isFirst = !this.hasSentFirst;
    if (isFirst) {
      this.hasSentFirst = true;
    }
    return {
      content,
      state,
      streamIndex: this.streamSeq++,
      isFirst,
      isLast,
    };
  }

  /**
   * 定时器触发的发送检查
   * 参照 logic tickerTrySend + splitAndSend
   */
  private tickerTrySend(): void {
    if (this.isFinished || this.sendErr) {
      this.stopTimers();
      return;
    }

    if (this.partialMsg.length === 0) return;

    // minInitialChars：首次发送至少积累指定字符数（优化推送通知体验）
    if (!this.hasSentFirst && this.partialMsg.length < this.config.minInitialChars) {
      return;
    }

    // throttleMs：全局节流，距离上次发送未超过节流间隔则跳过
    const elapsed = Date.now() - this.lastSendTime;
    if (this.hasSentFirst && elapsed < this.config.throttleMs) {
      return;
    }

    // 队列背压：如果队列中已有待发送分片，说明 API 还没消化完，不再入队新分片
    // 内容继续攒在 partialMsg，等队列清空后下次 tick 统一发，避免队列无限堆积
    if (this.queueDepth > 0) {
      return;
    }

    const sent = this.splitAndSend();
    if (!sent) return;
    this.sendCount++;

    // 变速逻辑：达到快速发送次数后切换到常规间隔
    if (this.sendCount === this.config.fastSendCount && this.tickerTimer) {
      clearInterval(this.tickerTimer);
      this.tickerTimer = setInterval(() => {
        this.tickerTrySend();
      }, this.config.sendInterval);
    }
  }

  /**
   * 执行 SplitMsg 拆分并发送
   * @returns true 表示实际入队了分片，false 表示未发送（内容为空或太短）
   */
  private splitAndSend(): boolean {
    try {
      const { sendMsg, waitMsg } = splitMsg(this.partialMsg);
      if (sendMsg.length === 0) {
        return false;
      }
      // 最小分片保护：切分结果太短则不发，继续攒
      if (sendMsg.length < this.config.minChunkChars && this.partialMsg.length < this.config.minChunkChars) {
        return false;
      }
      this.log(`splitMsg: send=${sendMsg.length}, wait=${waitMsg.length}`);
      this.doSendChunk(sendMsg);
      this.partialMsg = waitMsg;
      return true;
    } catch (e) {
      if (e instanceof SplitMsgError) {
        this.log("SplitMsg error, force end stream:", e.message);
        this.forceEnd = true;
        this.sendErr = e;
        return false;
      }
      throw e;
    }
  }

  /**
   * 强制发送缓冲区所有内容（fire-and-forget，用于字节阈值触发）
   * 参照 logic bytesThresholdTrySend → splitAndSend
   */
  private flushBuffered(): void {
    if (this.partialMsg.length === 0) return;
    // 队列中有待发送分片时不入队，等队列消化后由 tick 触发
    if (this.queueDepth > 0) {
      return;
    }
    this.splitAndSend();
  }

  /**
   * 强制发送缓冲区所有内容（等待完成，用于 finish 时确保最后分片发送成功后再发结束分片）
   * 循环调用 splitMsg 切分，确保大缓冲区不会作为一整块发出导致超平台单条限制
   */
  private async flushBufferedAsync(): Promise<void> {
    // 等待队列中正在飞行的分片完成
    await this.sendQueue;

    if (this.partialMsg.length === 0) {
      return;
    }

    // 循环切分：大缓冲区拆成多个合规分片
    while (this.partialMsg.length > 0) {
      try {
        const { sendMsg, waitMsg } = splitMsg(this.partialMsg);
        if (sendMsg.length === 0) {
          // splitMsg 找不到切分点，剩余内容整块发出
          break;
        }
        this.partialMsg = waitMsg;

        const isFirst = !this.hasSentFirst;
        const chunk: StreamChunk = {
          content: sendMsg,
          state: StreamState.TextGenerating,
          streamIndex: this.streamSeq++,
          isFirst,
          isLast: false,
        };
        if (isFirst) {
          this.hasSentFirst = true;
        }

        await this.sendCallback(chunk);
        this.lastSendTime = Date.now();
      } catch (err) {
        if (err instanceof SplitMsgError) {
          this.log("flushBufferedAsync splitMsg error:", err.message);
          // 切分失败，剩余内容整块发出
          break;
        }
        this.log("flushBufferedAsync sendCallback failed:", err);
        this.sendErr = err instanceof Error ? err : new Error(String(err));
        return;
      }
    }

    // 发送剩余无法切分的内容
    if (this.partialMsg.length > 0) {
      const content = this.partialMsg;
      this.partialMsg = "";

      const isFirst = !this.hasSentFirst;
      const chunk: StreamChunk = {
        content,
        state: StreamState.TextGenerating,
        streamIndex: this.streamSeq++,
        isFirst,
        isLast: false,
      };
      if (isFirst) {
        this.hasSentFirst = true;
      }

      try {
        await this.sendCallback(chunk);
        this.lastSendTime = Date.now();
      } catch (err) {
        this.log("flushBufferedAsync sendCallback failed:", err);
        this.sendErr = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  /**
   * 执行实际的分片发送
   * 参照 logic doSendChunk
   * 
   * 通过 sendQueue 串行化：每个分片排队等前一个发送完成后再发送，
   * 避免首个分片还没拿到 streamID 时后续分片就并发飞出去。
   * 不阻塞定时器（仍然 fire-and-forget），但 API 请求按序执行。
   */
  private doSendChunk(content: string): void {
    const chunk = this.makeChunk(content);

    const enqueueTime = Date.now();
    // 不在入队时更新 lastSendTime：backpressure（queueDepth > 0）已保证 API 在飞时不入新分片，
    // lastSendTime 只在 API 完成后更新，避免 throttleMs + API 耗时叠加导致发送延迟偏高
    this.queueDepth++;
    this.log(`doSendChunk: enqueue seq=${chunk.streamIndex}, len=${content.length}, queueDepth=${this.queueDepth}`);

    // 链式串行化：排队到 sendQueue 中，确保前一个分片发送完后再发送当前分片
    this.sendQueue = this.sendQueue
      .then(async () => {
        const apiStart = Date.now();
        await this.sendCallback(chunk);
        const apiMs = Date.now() - apiStart;
        this.log(`doSendChunk: done seq=${chunk.streamIndex}, apiMs=${apiMs}, queueWait=${apiStart - enqueueTime}ms`);
      })
      .then(() => {
        this.queueDepth--;
        // API 完成后再次更新，保证 throttle 基于最新的实际发送完成时间
        this.lastSendTime = Date.now();
        // 重置空白保活定时器
        this.resetBlankTimer();
      })
      .catch((err) => {
        this.queueDepth--;
        this.log("sendCallback failed:", err);
        this.sendErr = err instanceof Error ? err : new Error(String(err));
      });
  }

  /**
   * 发送空白分片保活
   * 参照 logic sendBlankChunk
   */
  private sendBlankChunk(): void {
    if (!this.hasSentFirst || this.isFinished || this.sendErr) return;

    const elapsed = Date.now() - this.lastSendTime;
    if (elapsed < this.config.blankSendInterval) {
      // 还没到时间，重置定时器
      this.resetBlankTimer();
      return;
    }

    // 缓冲区有内容时不发空白保活，内容分片本身就是保活
    if (this.partialMsg.length > 0) {
      this.resetBlankTimer();
      return;
    }

    // 队列中有分片在飞时不发空白保活
    if (this.queueDepth > 0) {
      this.resetBlankTimer();
      return;
    }

    const chunk: StreamChunk = {
      content: "",
      state: StreamState.TextGenerating,
      streamIndex: this.streamSeq++,
      isFirst: false,
      isLast: false,
    };

    this.queueDepth++;
    this.sendQueue = this.sendQueue
      .then(() => this.sendCallback(chunk))
      .then(() => {
        this.queueDepth--;
        this.lastSendTime = Date.now();
        this.resetBlankTimer();
      })
      .catch((err) => {
        this.queueDepth--;
        this.log("blank chunk send failed:", err);
        this.sendErr = err instanceof Error ? err : new Error(String(err));
      });
  }

  /**
   * 重置空白保活定时器
   */
  private resetBlankTimer(): void {
    if (this.blankTimer) {
      clearTimeout(this.blankTimer);
    }
    if (!this.isFinished) {
      this.blankTimer = setTimeout(() => {
        this.sendBlankChunk();
      }, this.config.blankSendInterval);
    }
  }

  /**
   * 停止所有定时器
   */
  private stopTimers(): void {
    if (this.tickerTimer) {
      clearInterval(this.tickerTimer);
      this.tickerTimer = null;
    }
    if (this.blankTimer) {
      clearTimeout(this.blankTimer);
      this.blankTimer = null;
    }
  }
}
