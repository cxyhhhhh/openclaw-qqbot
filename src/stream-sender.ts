/**
 * QQ Bot 流式消息发送器
 *
 * 参照 logic/message_sender.go 实现，封装 QQ 平台流式消息协议：
 * - Stream{State, ID, Index}：控制流式消息的开始、增量、结束
 * - Markdown msg_type=2：流式内容通过 markdown.content 发送
 * - ActionButton：首个分片携带操作按钮（反馈、TTS、分享、复制）
 * - MsgSeq 递增：每个分片使用独立的 msg_seq
 *
 * 与 StreamProcessor 配合使用：
 *   StreamProcessor 负责攒包/定时 → 产出 StreamChunk → StreamSender 转换为 QQ API 请求发送
 */

import {
  type StreamChunk,
  StreamProcessor,
  type StreamProcessorConfig,
} from "./stream-processor.js";
import {
  getAccessToken,
  apiRequest,
  isMarkdownSupport,
} from "./api.js";

/** QQ 流式消息请求体 */
interface StreamMessageBody {
  msg_type: number;
  markdown?: { content: string };
  content?: string;
  msg_id?: string;
  msg_seq: number;
  stream: {
    state: number;
    id: string;
    index: number;
  };
  action_button?: {
    feedback: boolean;
    tts: boolean;
    share: boolean;
    copy: boolean;
  };
}

/** 流式消息发送响应 */
interface StreamMessageResponse {
  id: string;
  timestamp: number | string;
}

/** 发送目标类型 */
export interface StreamTarget {
  type: "c2c" | "group" | "channel";
  /** c2c: openid, group: groupOpenid, channel: channelId */
  id: string;
  /** 原始消息 ID（用于被动回复） */
  messageId?: string;
}

/** StreamSender 配置 */
export interface StreamSenderConfig extends StreamProcessorConfig {
  /** 账户 appId */
  appId: string;
  /** 账户 clientSecret */
  clientSecret: string;
  /** 日志函数 */
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  /** 初始 msgSeq 计数器（用于多条消息场景避免 seq 冲突导致去重） */
  initialMsgSeqCounter?: number;
}

/**
 * StreamSender 流式消息发送器
 *
 * 封装 StreamProcessor + QQ API 发送的完整流程：
 *
 * ```typescript
 * const sender = new StreamSender(target, config);
 * sender.start();
 *
 * // 模型回复每产出一段内容时调用
 * sender.appendContent("你好");
 * sender.appendContent("，世界！");
 *
 * // 模型回复结束
 * await sender.finish();
 * ```
 */
export class StreamSender {
  private readonly target: StreamTarget;
  private readonly config: StreamSenderConfig;
  private readonly processor: StreamProcessor;

  private streamID = "";       // QQ 平台返回的流 ID
  private msgSeqCounter: number;   // 消息序号计数器
  private startTime = Date.now();

  private log: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };

  constructor(target: StreamTarget, config: StreamSenderConfig) {
    this.target = target;
    this.config = config;
    this.msgSeqCounter = config.initialMsgSeqCounter ?? 0;
    this.log = config.log ?? {
      info: (msg) => console.log(`[stream-sender] ${msg}`),
      error: (msg) => console.error(`[stream-sender] ${msg}`),
    };

    this.processor = new StreamProcessor(
      (chunk) => this.onSendChunk(chunk),
      (fullContent) => this.onFinish(fullContent),
      {
        ...config,
        logPrefix: `[stream-sender:${target.type}:${target.id.slice(0, 8)}]`,
      },
    );
  }

  // ===================== 公共 API =====================

  /**
   * 启动流式发送（启动攒包定时器循环）
   * 必须在 appendContent 之前调用
   */
  start(): void {
    this.startTime = Date.now();
    this.processor.startSendLoop();
    this.log.info(`Stream sender started, target: ${this.target.type}:${this.target.id.slice(0, 8)}`);
  }

  /**
   * 追加正文内容
   */
  appendContent(content: string): void {
    this.processor.appendContent(content);
  }

  /**
   * 正常结束流式发送
   */
  async finish(): Promise<void> {
    await this.processor.finish();
  }

  /**
   * 强制结束流式发送
   */
  async forceFinish(): Promise<void> {
    await this.processor.forceFinish();
  }

  /**
   * 中断流式发送（有新消息到达时调用）
   */
  interrupt(): void {
    this.processor.interrupt();
  }

  /** 是否已被中断 */
  isInterrupted(): boolean {
    return this.processor.isInterrupted();
  }

  /** 是否有发送错误 */
  hasSendErr(): boolean {
    return this.processor.hasSendErr();
  }

  /** 是否已发送有效内容 */
  hasSentContent(): boolean {
    return this.processor.hasSentContent();
  }

  /** 获取完整内容 */
  getFullContent(): string {
    return this.processor.getFullContent();
  }

  /** 获取流式消息 ID（QQ 平台返回的） */
  getStreamID(): string {
    return this.streamID;
  }

  /** 获取当前 msgSeq 计数器值（用于新 sender 继承避免去重） */
  getMsgSeqCounter(): number {
    return this.msgSeqCounter;
  }

  // ===================== 内部回调 =====================

  /**
   * 发送分片回调：将 StreamChunk 转换为 QQ API 请求
   * 参照 logic/message_sender.go SendStreamChunk
   */
  private async onSendChunk(chunk: StreamChunk): Promise<void> {
    // 非首个分片需要 streamID，没有则跳过（首个分片失败或未发成功）
    if (!chunk.isFirst && !this.streamID) {
      this.log.error(`streamID is empty, skip chunk seq=${chunk.streamIndex}, isLast=${chunk.isLast}`);
      return;
    }

    if (chunk.isFirst) {
      this.log.info(`First chunk send, latency: ${Date.now() - this.startTime}ms`);
    }

    const tokenStart = Date.now();
    const accessToken = await getAccessToken(
      this.config.appId,
      this.config.clientSecret,
    );
    const tokenMs = Date.now() - tokenStart;

    // 构建流式消息请求体
    const body = this.buildStreamMessageBody(chunk);

    // 发送请求
    const apiPath = this.getApiPath();
    const apiStart = Date.now();
    const rsp = await apiRequest<StreamMessageResponse>(
      accessToken,
      "POST",
      apiPath,
      body,
    );
    const apiMs = Date.now() - apiStart;

    this.log.info(`onSendChunk: seq=${chunk.streamIndex}, isFirst=${chunk.isFirst}, isLast=${chunk.isLast}, len=${chunk.content.length}, tokenMs=${tokenMs}, apiMs=${apiMs}`);

    // 首个分片：记录 streamID
    if (chunk.isFirst) {
      if (rsp?.id) {
        this.streamID = rsp.id;
        this.log.info(`Stream started with ID: ${this.streamID}`);
      } else {
        this.log.error("First chunk response missing stream ID");
      }
    }
  }

  /**
   * 构建流式消息请求体
   * 参照 logic/message_sender.go SendStreamChunk 中的 msgReq 构建
   */
  private buildStreamMessageBody(chunk: StreamChunk): StreamMessageBody {
    const msgSeq = ++this.msgSeqCounter;
    const useMarkdown = isMarkdownSupport();

    const body: StreamMessageBody = {
      msg_type: useMarkdown ? 2 : 0, // 2=markdown, 0=text
      msg_seq: msgSeq,
      stream: {
        state: chunk.state,
        id: this.streamID,
        index: chunk.streamIndex,
      },
    };

    // 设置消息内容（包括空白保活分片，QQ API 要求 msg_type=2 时必须有 markdown.content）
    // QQ 平台要求 markdown 流式分片必须以 \n 结尾
    if (useMarkdown) {
      let mdContent = chunk.content || "";
      if (mdContent.length > 0 && !mdContent.endsWith("\n")) {
        mdContent += "\n";
      }
      body.markdown = { content: mdContent };
    } else {
      body.content = chunk.content || "";
    }

    // 被动回复需要 msg_id
    if (this.target.messageId) {
      body.msg_id = this.target.messageId;
    }

    // 首个分片携带操作按钮
    if (chunk.isFirst) {
      body.action_button = {
        feedback: true,
        tts: true,
        share: true,
        copy: true,
      };
    }

    return body;
  }

  /**
   * 获取 API 路径
   */
  private getApiPath(): string {
    switch (this.target.type) {
      case "c2c":
        return `/v2/users/${this.target.id}/messages`;
      case "group":
        return `/v2/groups/${this.target.id}/messages`;
      case "channel":
        return `/channels/${this.target.id}/messages`;
      default:
        throw new Error(`Unsupported target type: ${this.target.type}`);
    }
  }

  /**
   * 完成回调
   */
  private async onFinish(fullContent: string): Promise<void> {
    this.log.info(
      `Stream message finished, total time: ${Date.now() - this.startTime}ms, content length: ${fullContent.length}`,
    );
  }
}
