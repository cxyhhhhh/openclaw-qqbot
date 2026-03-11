/**
 * 流式消息智能切分
 *
 * 参照 Go 版 common/msg/fmtx.go SplitMsg 实现。
 * 确保流式分片在安全位置（换行、括号平衡点）切断，
 * 避免 Markdown 链接、XML 自闭合标签等语法结构被拆开。
 */

/** 切分配置 */
export interface SplitMsgConfig {
  /** 单次切分最大字符数（rune 级别），默认 500 */
  sliceLen: number;
  /** 累积消息超过此字节长度仍找不到切分点则报错，默认 5000 */
  sliceMaxBytesLen: number;
}

const DEFAULT_SPLIT_CONFIG: SplitMsgConfig = {
  sliceLen: 500,
  sliceMaxBytesLen: 5000,
};

/** 切分结果 */
export interface SplitResult {
  /** 本次发送的内容 */
  sendMsg: string;
  /** 回写缓冲区等待下次发送的内容 */
  waitMsg: string;
}

/** SplitMsg 拆分错误 */
export class SplitMsgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SplitMsgError";
  }
}

/** 预编译正则：匹配连续自闭合 XML/HTML 标签（例如 <tag ... /><tag ... />） */
const TAG_PATTERN = /^(?:<[^>]+\/>)+/;

/** 预编译正则：匹配 Markdown 链接格式 [text](url) */
const MD_URL_RE = /\[(.*?)\]\((.*?)\)/g;

/** 预编译正则：匹配以中括号 [xxx] 结尾的表达式 */
const BRACKET_REGEX = /(\[[^\]]+\])$/;

/**
 * 智能切分消息
 *
 * 切分优先级：
 * 1. 最后一个换行符 \n
 * 2. 括号平衡点（确保 ()[]{}< > 不被切断）
 * 3. 返回空 sendMsg，继续等待更多内容
 *
 * @param msg 待切分的消息
 * @param config 切分配置（可选）
 * @returns SplitResult { sendMsg, waitMsg }
 * @throws SplitMsgError 累积消息超过 sliceMaxBytesLen 仍无法切分
 */
export function splitMsg(msg: string, config?: Partial<SplitMsgConfig>): SplitResult {
  // 删除假的 md 链接
  msg = removeFakeMdLinks(msg);
  if (msg.length === 0) {
    return { sendMsg: "", waitMsg: "" };
  }

  const cfg = { ...DEFAULT_SPLIT_CONFIG, ...config };

  const chars = [...msg]; // 按 Unicode 字符切分（等同于 Go 的 []rune）
  let maxLength = cfg.sliceLen;
  if (maxLength > chars.length) {
    maxLength = chars.length;
  }

  // 在 chars[:maxLength] 范围内寻找最佳切分点
  const cut = findBestSplitIndex(chars.slice(0, maxLength));
  if (cut > 0) {
    // 检测是否以 "[xxx]" 结尾，防止 md 链接语法被分割
    const raw = chars.slice(0, cut).join("");
    const [s1, s2] = splitMsgByBracket(raw);
    return {
      sendMsg: s1,
      waitMsg: s2 + chars.slice(cut).join(""),
    };
  }

  // 找不到切分点且消息字节长度超过上限，抛出错误
  if (Buffer.byteLength(msg, "utf-8") > cfg.sliceMaxBytesLen) {
    throw new SplitMsgError(
      `累积分片 ${Buffer.byteLength(msg, "utf-8")} 字节已超过最大长度 ${cfg.sliceMaxBytesLen}，无法切分`,
    );
  }

  // 没有找到切分点，继续等待更多内容
  return { sendMsg: "", waitMsg: msg };
}

// ===================== 内部辅助函数 =====================

/**
 * 寻找最佳切分位置
 *
 * 参照 Go 版 findBestSplitIndex：
 * 1. 优先找最后一个换行 \n
 * 2. 其次通过括号栈找最大括号平衡点
 */
function findBestSplitIndex(chars: string[]): number {
  // 先找最后一个换行
  const nlIdx = findLastNewline(chars);
  if (nlIdx > 0) {
    return nlIdx;
  }

  // 括号匹配
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };
  const openBrackets = new Set(["(", "[", "{", "<"]);
  const closeBrackets = new Set([")", "]", "}", ">"]);

  const stack: string[] = [];
  let maxBalanced = -1;

  for (let i = 0; i < chars.length; i++) {
    const r = chars[i];

    if (openBrackets.has(r)) {
      stack.push(r);
    } else if (closeBrackets.has(r)) {
      // 跳过 Markdown 引用语法 '>'
      if (r === ">" && stack.length === 0) {
        continue;
      }
      // 非法括号结构：栈为空，或栈顶不是对应的左括号
      if (stack.length === 0 || stack[stack.length - 1] !== pairs[r]) {
        return -1;
      }
      stack.pop();
    }

    if (stack.length === 0) {
      maxBalanced = i + 1;
    }
  }

  // 栈为空说明可以整段返回
  if (stack.length === 0) {
    return chars.length;
  }

  // 返回最后一个括号平衡点
  if (maxBalanced > 0) {
    return maxBalanced;
  }

  // 没找到切分点
  return -1;
}

/**
 * 从后往前找最后一个换行符位置
 * 返回换行符后一个字符的位置（即切分点），-1 表示没找到
 */
function findLastNewline(chars: string[]): number {
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] === "\n") {
      return i + 1;
    }
  }
  return -1;
}

/**
 * 根据中括号切割消息
 * 如果消息以 "[xxx]" 结尾，则把 "[xxx]" 切割到 waitMsg，
 * 防止 md 链接语法 [text](url) 被分割开导致检测不到假链接
 */
function splitMsgByBracket(msg: string): [sendMsg: string, waitMsg: string] {
  if (!msg.endsWith("]")) {
    return [msg, ""];
  }

  const match = BRACKET_REGEX.exec(msg);
  if (match && match[0]) {
    const fullMatch = match[0];
    const sendMsg = msg.slice(0, msg.length - fullMatch.length);
    return [sendMsg, fullMatch];
  }

  return [msg, ""];
}

/**
 * 删除假的 md 链接（非 http/https 的链接只保留文字部分）
 * 参照 Go 版 removeFakeMdLinks
 */
function removeFakeMdLinks(s: string): string {
  if (!MD_URL_RE.test(s)) {
    return s;
  }
  // 重置 lastIndex（因为上面 test 会推进 lastIndex）
  MD_URL_RE.lastIndex = 0;

  return s.replace(MD_URL_RE, (fullMatch, text: string, url: string) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return fullMatch; // 保留合法链接
    }
    return text; // 只保留文字
  });
}
