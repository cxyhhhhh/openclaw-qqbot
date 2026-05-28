/**
 * 流式消息媒体协同
 *
 * 流式输出过程中遇到媒体标签时暂停流 → 发送媒体 → 恢复流。
 *
 * 核心逻辑：
 * 1. 累积 AI 输出的 chunk 到 buffer
 * 2. 每次 chunk 到达后检查 buffer 是否包含完整的媒体标签
 * 3. 如果检测到 → 暂停流 → 将标签前的文本发送为最终流式内容 → 发送媒体 → 恢复流
 * 4. 如果没有 → 继续正常 stream.update
 */
import { hasMediaTags, extractMediaTags } from './media-tags.js';
import type { MediaKind } from './outbound-service.js';

export interface StreamMediaContext {
  /** 暂停流（发送当前积累的文本作为最终内容） */
  pauseAndFlush: (text: string) => Promise<void>;
  /** 发送媒体 */
  sendMedia: (source: string, kind: MediaKind) => Promise<void>;
  /** 恢复流（开始新的流式 session） */
  resume: () => Promise<void>;
  /** 普通流式更新 */
  update: (text: string) => Promise<void>;
}

/**
 * 流式媒体感知 chunk 处理器
 *
 * 包裹在流式 dispatch 的 onChunk 回调中使用。
 */
export class StreamMediaHandler {
  private buffer = '';
  private paused = false;

  constructor(private readonly ctx: StreamMediaContext) {}

  /**
   * 处理一个 chunk：累积到 buffer → 检查媒体标签 → 决定暂停/继续
   */
  async handleChunk(chunk: string): Promise<void> {
    this.buffer += chunk;

    // 快速判断：buffer 中没有任何媒体标签迹象 → 正常 update
    if (!hasMediaTags(this.buffer)) {
      if (!this.paused) {
        await this.ctx.update(this.buffer);
      }
      return;
    }

    // 检查是否有完整的闭合标签（不能在未闭合时就触发）
    const { tags, cleanText } = extractMediaTags(this.buffer);
    if (tags.length === 0) {
      // 有开头但未闭合 → 等更多 chunk
      if (!this.paused) {
        // 只 update 到可安全发送的部分（标签开头前的文本）
        const safeText = getTextBeforeOpenTag(this.buffer);
        if (safeText) {
          await this.ctx.update(safeText);
        }
      }
      return;
    }

    // 有完整标签 → 暂停流 → 发送前置文本 → 发送媒体 → 恢复
    const preText = cleanText.trim();
    if (preText) {
      await this.ctx.pauseAndFlush(preText);
    } else {
      await this.ctx.pauseAndFlush('');
    }

    this.paused = true;

    for (const tag of tags) {
      const kind = tagToKind(tag.tag);
      await this.ctx.sendMedia(tag.source, kind);
    }

    // 恢复流
    await this.ctx.resume();
    this.paused = false;

    // 清空 buffer（已处理）
    this.buffer = '';
  }

  /**
   * 流结束时 flush 剩余 buffer
   */
  async flush(): Promise<void> {
    if (this.buffer.trim() && !this.paused) {
      await this.ctx.update(this.buffer);
    }
    this.buffer = '';
  }
}

// ── 辅助 ──

function getTextBeforeOpenTag(text: string): string {
  // 找到第一个 < 后跟 tag 名的位置
  const match = text.match(/<\s*(?:qq|media|image|img|pic|photo|voice|audio|video|file|doc|attachment|attach|send)/i);
  if (match?.index !== undefined && match.index > 0) {
    return text.slice(0, match.index);
  }
  return '';
}

function tagToKind(tag: string): MediaKind {
  switch (tag) {
    case 'qqvoice': return 'voice';
    case 'qqvideo': return 'video';
    case 'qqfile': return 'file';
    default: return 'image';
  }
}
