/**
 * 富媒体标签解析（出站）
 *
 * 解析 AI 回复中的 <qqmedia> 标签，分离为文本和媒体发送队列。
 * 从原 src/utils/media-tags.ts 迁移核心逻辑。
 *
 * 注：此文件保留了标签别名映射和正则逻辑，是独立版独有功能。
 * SDK 本身不处理 <qqmedia> 标签（这是 OpenClaw AI 层面的约定）。
 */

// 标准标签名
const VALID_TAGS = ['qqimg', 'qqvoice', 'qqvideo', 'qqfile', 'qqmedia'] as const;

// 标签别名映射
const TAG_ALIASES: Record<string, typeof VALID_TAGS[number]> = {
  'qq_img': 'qqimg', 'qqimage': 'qqimg', 'qq_image': 'qqimg',
  'qqpic': 'qqimg', 'qq_pic': 'qqimg', 'qqpicture': 'qqimg',
  'qq_picture': 'qqimg', 'qqphoto': 'qqimg', 'qq_photo': 'qqimg',
  'img': 'qqimg', 'image': 'qqimg', 'pic': 'qqimg',
  'picture': 'qqimg', 'photo': 'qqimg',
  'qq_voice': 'qqvoice', 'qqaudio': 'qqvoice', 'qq_audio': 'qqvoice',
  'voice': 'qqvoice', 'audio': 'qqvoice',
  'qq_video': 'qqvideo', 'video': 'qqvideo',
  'qq_file': 'qqfile', 'qqdoc': 'qqfile', 'qq_doc': 'qqfile',
  'file': 'qqfile', 'doc': 'qqfile', 'document': 'qqfile',
  'qq_media': 'qqmedia', 'media': 'qqmedia',
  'attachment': 'qqmedia', 'attach': 'qqmedia',
  'qqattachment': 'qqmedia', 'qq_attachment': 'qqmedia',
  'qqsend': 'qqmedia', 'qq_send': 'qqmedia', 'send': 'qqmedia',
};

export type MediaTagType = typeof VALID_TAGS[number];

export interface ParsedMediaTag {
  tag: MediaTagType;
  source: string;
  originalMatch: string;
}

/**
 * 规范化标签名
 */
function normalizeTag(name: string): MediaTagType | null {
  const lower = name.toLowerCase();
  if ((VALID_TAGS as readonly string[]).includes(lower)) return lower as MediaTagType;
  return TAG_ALIASES[lower] ?? null;
}

/**
 * 检测文本中是否包含媒体标签（快速判断）
 */
export function hasMediaTags(text: string): boolean {
  return /<\s*(?:qq|media|image|img|pic|photo|voice|audio|video|file|doc|attachment|attach|send)/i.test(text);
}

/**
 * 从文本中提取所有媒体标签，返回标签列表和清除标签后的纯文本
 */
export function extractMediaTags(text: string): { tags: ParsedMediaTag[]; cleanText: string } {
  const tags: ParsedMediaTag[] = [];
  let cleanText = text;

  // 匹配自闭合标签: <qqmedia file="/path" /> 或 <qqmedia>/path</qqmedia>
  const allTagNames = [...VALID_TAGS, ...Object.keys(TAG_ALIASES)].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `<\\s*(${allTagNames.join('|')})\\s+(?:file|src|path|url)\\s*=\\s*["']?([^"'<>\\s]+)["']?\\s*/?>`,
    'gi',
  );

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const tag = normalizeTag(match[1]);
    if (tag) {
      tags.push({ tag, source: match[2], originalMatch: match[0] });
      cleanText = cleanText.replace(match[0], '');
    }
  }

  // 匹配包围标签: <qqmedia>/path</qqmedia>
  const wrapPattern = new RegExp(
    `<\\s*(${allTagNames.join('|')})\\s*>\\s*([^<]+?)\\s*</\\s*\\1\\s*>`,
    'gi',
  );
  while ((match = wrapPattern.exec(text)) !== null) {
    const tag = normalizeTag(match[1]);
    if (tag && !tags.some(t => t.originalMatch === match![0])) {
      tags.push({ tag, source: match[2].trim(), originalMatch: match[0] });
      cleanText = cleanText.replace(match[0], '');
    }
  }

  return { tags, cleanText: cleanText.trim() };
}
