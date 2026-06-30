/**
 * 流式文本的媒体标签辅助函数
 *
 * 服务于流式发送场景：
 *  - findFirstClosedMediaTag: 找到第一个**完整闭合**的媒体标签（用于中断流式 → 同步发媒体）
 *  - stripIncompleteMediaTag: 从文本末尾剥离**未闭合**的媒体标签前缀
 *    （流式分片到达时，最后一截可能是 "...开始<qqi" 这种残缺前缀，
 *     必须截断后再 sendStreamChunk，否则 QQ 客户端会渲染出残缺尖括号）
 */

import { normalizePath } from '../utils/platform.js';

/** 统一的媒体标签正则（与 media-tags.ts 的别名集合保持一致） */
const MEDIA_TAG_REGEX = /<(qqimg|qqvoice|qqvideo|qqfile|qqmedia|img)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|qqmedia|img)>/gi;

/** 用于未闭合检测的媒体标签名集合（包含所有别名） */
const MEDIA_NAMES = [
  'qq', 'img', 'image', 'pic', 'photo', 'voice', 'audio', 'video',
  'file', 'doc', 'media', 'attach', 'send', 'document', 'picture',
  'qqvoice', 'qqaudio', 'qqvideo', 'qqimg', 'qqimage', 'qqfile',
  'qqpic', 'qqphoto', 'qqmedia', 'qqattach', 'qqsend', 'qqdocument', 'qqpicture',
] as const;

export type MediaItemType = 'image' | 'voice' | 'video' | 'file' | 'media';

export interface FirstClosedMediaTag {
  /** 标签前的纯文本（流式应先发完此段再终结） */
  textBefore: string;
  /** 规范化后的标签名 */
  tagName: 'qqimg' | 'qqvoice' | 'qqvideo' | 'qqfile' | 'qqmedia' | 'img';
  /** 提取并规范化后的媒体源（本地路径 / URL / data URL） */
  mediaPath: string;
  /** 标签结束位置（exclusive，用于推进 sentIndex） */
  tagEndIndex: number;
  /** 媒体类型（供 sendMedia 路由） */
  itemType: MediaItemType;
}

const TAG_TO_ITEM_TYPE: Record<string, MediaItemType> = {
  qqimg: 'image',
  img: 'image',
  qqvoice: 'voice',
  qqvideo: 'video',
  qqfile: 'file',
  qqmedia: 'media',
};

/**
 * 判断字符位置是否处于 fenced code block (\`\`\`...\`\`\`) 内。
 * 代码块内的"标签"应被忽略，避免把示例代码当作真实媒体指令。
 */
export function isInsideCodeBlock(text: string, position: number): boolean {
  const fenceRegex = /^(`{3,})[^\n]*$/gm;
  let fenceMatch: RegExpExecArray | null;
  let openFence: { pos: number; ticks: number } | null = null;
  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    const ticks = fenceMatch[1].length;
    if (!openFence) {
      openFence = { pos: fenceMatch.index, ticks };
    } else if (ticks >= openFence.ticks) {
      if (position >= openFence.pos && position < fenceMatch.index + fenceMatch[0].length) {
        return true;
      }
      openFence = null;
    }
  }
  return openFence !== null && position >= openFence.pos;
}

/**
 * 找到第一个**已完整闭合**的媒体标签。
 *
 * 用于流式中断模型：流式发送过程中，每当 normalize 后的全量文本里出现完整的
 * `<qqimg>path</qqimg>` 这类标签，就需要：
 *  1. 把标签前的安全文本通过流式发完 → 终结当前流式会话
 *  2. 同步上传 + 发送媒体
 *  3. 以 tagEndIndex 推进 sentIndex，开启新的流式会话继续后面的文本
 *
 * @returns null 表示文本中暂无可处理的完整媒体标签
 */
export function findFirstClosedMediaTag(text: string): FirstClosedMediaTag | null {
  if (!text) return null;
  const regex = new RegExp(MEDIA_TAG_REGEX.source, MEDIA_TAG_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    // 跳过代码块内的伪标签（示例代码不应被处理）
    if (isInsideCodeBlock(text, match.index)) continue;

    const tagName = match[1].toLowerCase() as FirstClosedMediaTag['tagName'];
    let mediaPath = match[2]?.trim() ?? '';
    // 兼容 LLM 偶尔输出的 MEDIA: 前缀
    if (mediaPath.startsWith('MEDIA:')) {
      mediaPath = mediaPath.slice('MEDIA:'.length).trim();
    }
    mediaPath = normalizePath(mediaPath);

    return {
      textBefore: text.slice(0, match.index),
      tagName,
      mediaPath,
      tagEndIndex: match.index + match[0].length,
      itemType: TAG_TO_ITEM_TYPE[tagName] ?? 'image',
    };
  }
  return null;
}

/**
 * 从文本**末尾**剥离不完整的媒体标签前缀，返回 `[safe, didStrip]`。
 *
 * 流式分片每次到达时，文本可能停在标签中间（如 `"开始 <qqim"`），
 * 直接 sendStreamChunk 会让用户在客户端看到残缺尖括号。
 * 本函数仅检查 **最后一行**，遇到未闭合的媒体标签开/闭前缀就截断到 `<` 之前。
 *
 * 设计要点：
 *  - 只看最后一行 — 之前的行 normalize 时已经处理过
 *  - 仅匹配媒体标签名 — 不影响真实文本中的 `<`（如代码片段 `<div>`）
 *  - 容错"未完成的别名前缀"（`<i`、`<qq` 等可能是 `<img>`/`<qqimg>`）
 */
export function stripIncompleteMediaTag(text: string): [safe: string, didStrip: boolean] {
  if (!text) return [text, false];

  const lastNL = text.lastIndexOf('\n');
  const lastLine = lastNL === -1 ? text : text.slice(lastNL + 1);
  if (!lastLine) return [text, false]; // 以换行结尾，安全

  const lineStart = lastNL === -1 ? 0 : lastNL + 1;

  const isMedia = (n: string): boolean => MEDIA_NAMES.includes(n.toLowerCase() as typeof MEDIA_NAMES[number]);
  const couldBeMedia = (n: string): boolean => {
    const l = n.toLowerCase();
    return MEDIA_NAMES.some((m) => m.startsWith(l));
  };
  const cutAt = (pos: number): [string, boolean] => [
    text.slice(0, lineStart + pos).trimEnd(),
    true,
  ];
  const hasClosingAfter = (pos: number, name: string): boolean => {
    const rest = lastLine.slice(pos + 1);
    const gt = rest.search(/[>＞]/);
    if (gt < 0) return false;
    const after = rest.slice(gt + 1);
    return new RegExp(`[<\uFF1C]/${name}\\s*[>\uFF1E]`, 'i').test(after);
  };

  // 回溯状态机
  let searchTag: string | null = null; // '*' = 来自孤立 <
  let searchIsClosing = false;
  let fallbackPos = -1;

  for (let i = lastLine.length - 1; i >= 0; i--) {
    const ch = lastLine[i];
    if (ch !== '<' && ch !== '\uFF1C') continue;

    const after = lastLine.slice(i + 1);
    const isClosing = after.startsWith('/');
    const nameStr = isClosing ? after.slice(1) : after;
    const nameMatch = nameStr.match(/^(\w+)/);

    // 回溯：正在找对应的开标签
    if (searchTag) {
      if (!nameMatch || isClosing) continue;
      const cand = nameMatch[1].toLowerCase();
      if (!isMedia(cand)) continue;
      if (hasClosingAfter(i, cand)) continue;
      if (searchTag === '*') return cutAt(i);
      const t = searchTag.toLowerCase();
      if (cand === t || cand.startsWith(t)) return cutAt(i);
      continue;
    }

    // 正常扫描
    if (!nameMatch) {
      if (!after) {
        if (fallbackPos < 0) fallbackPos = i;
        searchTag = '*';
        searchIsClosing = false;
      } else if (after === '/') {
        if (fallbackPos < 0) fallbackPos = i;
        searchTag = '*';
        searchIsClosing = true;
      }
      continue;
    }

    const tag = nameMatch[1];
    const restAfterName = nameStr.slice(tag.length);
    const hasGT = /[>＞]/.test(restAfterName);

    if (!isMedia(tag) && !(couldBeMedia(tag) && !hasGT)) continue;

    if (!hasGT) {
      if (isClosing) {
        if (fallbackPos < 0) fallbackPos = i;
        searchTag = tag;
        searchIsClosing = true;
        continue;
      }
      return cutAt(i);
    }

    if (isClosing) return [text, false];
    if (hasClosingAfter(i, tag)) return [text, false];
    return cutAt(i);
  }

  if (searchTag) {
    if (!searchIsClosing) {
      return cutAt(fallbackPos);
    }
    return [text, true];
  }
  return [text, false];
}
