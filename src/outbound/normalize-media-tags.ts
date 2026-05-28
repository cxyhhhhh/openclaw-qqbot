/**
 * 媒体标签规范化
 *
 * 将 AI 输出的各种非标准格式规范化为 `<qqimg>source</qqimg>` 标准格式：
 * - 全角尖括号 `＜qqimg＞` → `<qqimg>`
 * - HTML 实体 `&lt;qqimg&gt;` → `<qqimg>`
 * - 自闭合属性 `<qqimg src="url"/>` → `<qqimg>url</qqimg>`
 * - 别名标签 `<image>url</image>` → `<qqimg>url</qqimg>`
 * - 多行标签体清理（去除换行/制表）
 * - `~` home 路径展开
 * - 代码块内标签保护（不处理）
 *
 * 这是出站标签解析（extractMediaTags）的前置步骤。
 */
import * as os from 'node:os';

// ── 标准标签名 ──
const VALID_TAGS = ['qqimg', 'qqvoice', 'qqvideo', 'qqfile', 'qqmedia'] as const;
type ValidTag = typeof VALID_TAGS[number];

// ── 别名映射（与 media-tags.ts 保持一致 + 扩展）──
const TAG_ALIASES: Record<string, ValidTag> = {
  'img': 'qqimg', 'image': 'qqimg', 'pic': 'qqimg', 'picture': 'qqimg', 'photo': 'qqimg',
  'qq_img': 'qqimg', 'qqimage': 'qqimg', 'qq_image': 'qqimg',
  'qqpic': 'qqimg', 'qq_pic': 'qqimg', 'qqpicture': 'qqimg',
  'qq_picture': 'qqimg', 'qqphoto': 'qqimg', 'qq_photo': 'qqimg',

  'voice': 'qqvoice', 'audio': 'qqvoice',
  'qq_voice': 'qqvoice', 'qqaudio': 'qqvoice', 'qq_audio': 'qqvoice',

  'video': 'qqvideo', 'qq_video': 'qqvideo',

  'file': 'qqfile', 'doc': 'qqfile', 'document': 'qqfile',
  'qq_file': 'qqfile', 'qqdoc': 'qqfile', 'qq_doc': 'qqfile',

  'media': 'qqmedia', 'attachment': 'qqmedia', 'attach': 'qqmedia',
  'qq_media': 'qqmedia', 'qqattachment': 'qqmedia', 'qq_attachment': 'qqmedia',
  'qqsend': 'qqmedia', 'qq_send': 'qqmedia', 'send': 'qqmedia',
};

function resolveTag(name: string): ValidTag | null {
  const lower = name.toLowerCase().trim();
  if ((VALID_TAGS as readonly string[]).includes(lower)) return lower as ValidTag;
  return TAG_ALIASES[lower] ?? null;
}

// ── 所有合法标签名（含别名），按长度降序排列 ──
const ALL_TAG_NAMES = [...VALID_TAGS, ...Object.keys(TAG_ALIASES)].sort((a, b) => b.length - a.length);
const ALL_TAG_PATTERN = ALL_TAG_NAMES.join('|');

/**
 * 将 AI 输出的各种非标准媒体标签规范化为标准 `<qqXXX>source</qqXXX>` 格式。
 *
 * @example
 * ```ts
 * normalizeMediaTags('<image src="~/img.png" />')
 * // → '<qqimg>/Users/xxx/img.png</qqimg>'
 *
 * normalizeMediaTags('＜qqimg＞https://x/a.jpg＜/qqimg＞')
 * // → '<qqimg>https://x/a.jpg</qqimg>'
 * ```
 */
export function normalizeMediaTags(text: string): string {
  let result = text;

  // Step 0: 保护代码块（```...```）中的内容
  const codeBlocks: string[] = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Step 1: 全角尖括号 → 半角
  result = result.replace(/[＜﹤]/g, '<').replace(/[＞﹥]/g, '>');

  // Step 2: HTML 实体 → 真实字符
  result = result.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&amp;/gi, '&');

  // Step 3: 自闭合标签 → 包围标签
  // <tagname file="source"/> 或 <tagname src="source" /> 等
  const selfClosePattern = new RegExp(
    `<\\s*(${ALL_TAG_PATTERN})\\s+(?:file|src|path|url)\\s*=\\s*["']?([^"'<>\\s]+)["']?\\s*/?>`,
    'gi',
  );
  result = result.replace(selfClosePattern, (_match, tagName: string, source: string) => {
    const tag = resolveTag(tagName);
    if (!tag) return _match;
    return `<${tag}>${expandTilde(source)}</${tag}>`;
  });

  // Step 4: 包围标签 — 别名规范化 + 多行体清理
  const wrapPattern = new RegExp(
    `<\\s*(${ALL_TAG_PATTERN})\\s*>([\\s\\S]*?)<\\s*/\\s*(?:${ALL_TAG_PATTERN})\\s*>`,
    'gi',
  );
  result = result.replace(wrapPattern, (_match, tagName: string, body: string) => {
    const tag = resolveTag(tagName);
    if (!tag) return _match;
    // 多行体清理：去除换行/制表/前后空白
    const cleaned = body.replace(/[\r\n\t]+/g, '').trim();
    if (!cleaned) return _match;
    return `<${tag}>${expandTilde(cleaned)}</${tag}>`;
  });

  // Step 5: 恢复代码块
  result = result.replace(/\x00CB(\d+)\x00/g, (_match, idx) => {
    return codeBlocks[Number(idx)];
  });

  return result;
}

/**
 * 展开 `~` 为用户 home 目录
 */
function expandTilde(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return filepath.replace(/^~/, os.homedir());
  }
  return filepath;
}
