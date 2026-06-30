/**
 * Runtime Contract Check — 启动时校验必需 API 可用性。
 *
 * 在 plugin.register() 中立刻调用：如果 required API 缺失则 throw，
 * 框架会记录 "plugin incompatible" 并跳过加载，
 * 比等到第一条消息进来才报错要好得多。
 */

import type { PluginRuntime } from 'openclaw/plugin-sdk';

// ── 契约定义 ──

interface ApiProbe {
  name: string;
  probe: (rt: PluginRuntime) => boolean;
}

/**
 * 必需 API — 缺失任何一个都意味着插件无法正常工作。
 * 每条 probe 包含多个候选路径（应对 API 重命名）。
 */
const REQUIRED: ApiProbe[] = [
  {
    name: 'channel.inbound.run',
    probe: (rt) => {
      const c = (rt as any).channel;
      return typeof c?.inbound?.run === 'function' || typeof c?.turn?.run === 'function';
    },
  },
  {
    name: 'channel.reply.dispatchReplyWithBufferedBlockDispatcher',
    probe: (rt) => typeof (rt as any).channel?.reply?.dispatchReplyWithBufferedBlockDispatcher === 'function',
  },
];

/**
 * 可选 API — 缺失时特定功能降级，但不影响核心消息处理。
 *
 * 新版 API 优先探测，deprecated API 仅作为低版本兼容标记。
 */
const OPTIONAL: ApiProbe[] = [
  {
    name: 'channel.inbound.buildContext',
    probe: (rt) => typeof (rt as any).channel?.inbound?.buildContext === 'function',
  },
  {
    name: 'channel.reply.formatAgentEnvelope',
    probe: (rt) => typeof (rt as any).channel?.reply?.formatAgentEnvelope === 'function',
  },
  {
    name: 'channel.text.chunkMarkdownText',
    probe: (rt) => typeof (rt as any).channel?.text?.chunkMarkdownText === 'function',
  },
  {
    name: 'channel.routing.resolveAgentRoute',
    probe: (rt) => typeof (rt as any).channel?.routing?.resolveAgentRoute === 'function',
  },
  {
    name: 'channel.session.resolveStorePath (deprecated)',
    probe: (rt) => typeof (rt as any).channel?.session?.resolveStorePath === 'function',
  },
  {
    name: 'channel.session.recordInboundSession (deprecated)',
    probe: (rt) => typeof (rt as any).channel?.session?.recordInboundSession === 'function',
  },
  {
    name: 'channel.reply.finalizeInboundContext (deprecated)',
    probe: (rt) => typeof (rt as any).channel?.reply?.finalizeInboundContext === 'function',
  },
  {
    name: 'channel.reply.formatInboundEnvelope (deprecated)',
    probe: (rt) => typeof (rt as any).channel?.reply?.formatInboundEnvelope === 'function',
  },
  {
    name: 'config.current',
    probe: (rt) => typeof (rt as any).config?.current === 'function',
  },
];

// ── 公共接口 ──

export interface ContractResult {
  ok: boolean;
  version: string;
  missing: string[];
  degraded: string[];
}

/**
 * 校验 runtime 符合插件契约。
 *
 * @returns `ContractResult` — `ok: false` 表示有必需 API 缺失，插件应拒绝加载。
 */
export function verifyRuntimeContract(
  rt: PluginRuntime,
  log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
): ContractResult {
  const version = (rt as any).version ?? 'unknown';
  const missing: string[] = [];
  const degraded: string[] = [];

  for (const r of REQUIRED) {
    if (!r.probe(rt)) missing.push(r.name);
  }
  for (const r of OPTIONAL) {
    if (!r.probe(rt)) degraded.push(r.name);
  }

  // 日志输出
  if (log) {
    log.info(
      `[qqbot:contract] openclaw=${version} required=${REQUIRED.length - missing.length}/${REQUIRED.length} degraded=${degraded.length}/${OPTIONAL.length}`,
    );
    if (missing.length) {
      log.error(`[qqbot:contract] BROKEN — missing required APIs: ${missing.join(', ')}`);
    }
    if (degraded.length) {
      log.warn(`[qqbot:contract] degraded: ${degraded.join(', ')}`);
    }
  }

  return { ok: missing.length === 0, version, missing, degraded };
}
