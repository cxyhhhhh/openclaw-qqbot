/**
 * QQBot 插件运行时管理 & 结构化日志工厂。
 *
 * 日志通过 `runtime.logging.getChildLogger()` 接入 OpenClaw 框架，
 * 框架自动追加 [qqbot] 前缀。支持：
 * - 懒解析 runtime（模块顶层调用也不会报错）
 * - 自动注入追踪上下文（accountId、messageId、openId）
 * - 降级到 console fallback（带 ANSI 颜色）
 *
 * Usage:
 *   import { qqbotLogger } from './runtime.js';
 *   const log = qqbotLogger('gateway');
 *   log.info('connected', { accountId: 'default' });
 */

import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk";
import { getRequestContext } from "./request-context.js";
import { setOpenClawVersion } from "./bot-instance.js";

// ─── Runtime Store ───────────────────────────────────────────────────────────

let runtime: PluginRuntime | null = null;

export function setQQBotRuntime(next: PluginRuntime) {
  runtime = next;
  setOpenClawVersion(next.version);
}

export function getQQBotRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("QQBot runtime not initialized");
  }
  return runtime;
}

export function tryGetQQBotRuntime(): PluginRuntime | null {
  return runtime;
}

// ─── QQBot Logger ────────────────────────────────────────────────────────────

export interface QQBotLogger {
  readonly subsystem: string;
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(name: string): QQBotLogger;
}

// ─── ANSI Console Fallback ───────────────────────────────────────────────────

const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

function consoleFallback(subsystem: string): RuntimeLogger {
  const tag = `qqbot/${subsystem}`;
  return {
    debug: (msg, meta) => console.debug(`${GRAY}[${tag}]${RESET}`, msg, ...(meta ? [meta] : [])),
    info: (msg, meta) => console.log(`${CYAN}[${tag}]${RESET}`, msg, ...(meta ? [meta] : [])),
    warn: (msg, meta) => console.warn(`${YELLOW}[${tag}]${RESET}`, msg, ...(meta ? [meta] : [])),
    error: (msg, meta) => console.error(`${RED}[${tag}]${RESET}`, msg, ...(meta ? [meta] : [])),
  };
}

// ─── Runtime Logger Resolution ───────────────────────────────────────────────

function resolveRuntimeLogger(subsystem: string): RuntimeLogger | null {
  try {
    const r = runtime;
    if (!r) return null;
    return r.logging.getChildLogger({
      subsystem: `qqbot/${subsystem}`,
    });
  } catch {
    return null;
  }
}

// ─── Trace Context Enrichment ────────────────────────────────────────────────

function getTraceMeta(): Record<string, unknown> | null {
  const ctx = getRequestContext();
  if (!ctx) return null;
  const trace: Record<string, unknown> = {};
  if (ctx.accountId) trace.accountId = ctx.accountId;
  if (ctx.messageId) trace.messageId = ctx.messageId;
  if (ctx.openId) trace.openId = ctx.openId;
  return Object.keys(trace).length > 0 ? trace : null;
}

function enrichMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const trace = getTraceMeta();
  if (!trace) return meta ?? {};
  return meta ? { ...trace, ...meta } : trace;
}

// ─── Message Formatting ──────────────────────────────────────────────────────

/**
 * 构建带追踪上下文的日志前缀。
 *
 * 格式: `qqbot[accountId][msg:xxx]:`
 */
function buildTracePrefix(): string {
  const ctx = getRequestContext();
  if (!ctx) return 'qqbot:';
  const parts = ['qqbot'];
  if (ctx.accountId) parts.push(`[${ctx.accountId}]`);
  if (ctx.messageId) parts.push(`[msg:${ctx.messageId.slice(0, 12)}]`);
  return `${parts.join('')}:`;
}

function formatMessage(message: string, meta: Record<string, unknown> | undefined): string {
  const prefix = buildTracePrefix();
  if (!meta || Object.keys(meta).length === 0) return `${prefix} ${message}`;
  const parts = Object.entries(meta)
    .map(([k, v]) => {
      if (v === undefined || v == null) return null;
      if (typeof v === 'object') return `${k}=${JSON.stringify(v)}`;
      return `${k}=${v}`;
    })
    .filter(Boolean);
  return parts.length > 0 ? `${prefix} ${message} (${parts.join(', ')})` : `${prefix} ${message}`;
}

// ─── Logger Factory ──────────────────────────────────────────────────────────

function createQQBotLogger(subsystem: string): QQBotLogger {
  // 懒解析：模块顶层调用时 runtime 可能还未初始化
  let cachedLogger: RuntimeLogger | null = null;
  let resolved = false;

  function resolveLogger(): RuntimeLogger {
    if (!resolved) {
      cachedLogger = resolveRuntimeLogger(subsystem);
      if (cachedLogger) resolved = true;
    }
    return cachedLogger ?? consoleFallback(subsystem);
  }

  return {
    subsystem,
    debug(message: string, meta?: Record<string, unknown>): void {
      resolveLogger().debug?.(formatMessage(message, meta), enrichMeta(meta));
    },
    info(message: string, meta?: Record<string, unknown>): void {
      resolveLogger().info(formatMessage(message, meta), enrichMeta(meta));
    },
    warn(message: string, meta?: Record<string, unknown>): void {
      resolveLogger().warn(formatMessage(message, meta), enrichMeta(meta));
    },
    error(message: string, meta?: Record<string, unknown>): void {
      resolveLogger().error(formatMessage(message, meta), enrichMeta(meta));
    },
    child(name: string): QQBotLogger {
      return createQQBotLogger(`${subsystem}/${name}`);
    },
  };
}

/**
 * 创建 QQBot 子系统 logger。
 *
 * 支持模块顶层调用（懒解析 runtime），自动注入请求追踪上下文。
 *
 * @example
 *   const log = qqbotLogger('gateway');
 *   log.info('bot connected');
 *   log.child('interaction').warn('unhandled button');
 */
export function qqbotLogger(subsystem: string): QQBotLogger {
  return createQQBotLogger(subsystem);
}

/**
 * 获取默认 qqbot logger（向后兼容）。
 *
 * 等价于 qqbotLogger('core')，供已有代码平滑迁移。
 */
export function getLogger(): QQBotLogger {
  return qqbotLogger('core');
}
