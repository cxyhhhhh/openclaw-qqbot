/**
 * QQBot 文本消毒
 *
 * 剥离框架内部脚手架标签（system-reminder、prompt-data 等），
 * 保留 Markdown/HTML 用于 QQ Bot Markdown 渲染。
 */

const INTERNAL_TAGS = [/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, /<previous_response\b[^>]*>[\s\S]*?<\/previous_response>/gi, /<\s*\/?\s*(?:system-reminder|previous_response)\b[^>]*\/?\s*>/gi];

/** 剥离内部运行时脚手架块 */
export function sanitizeQQBotText(text: string): string {
  let result = text;
  for (const re of INTERNAL_TAGS) {
    result = result.replace(re, '');
  }
  return result.trim();
}
