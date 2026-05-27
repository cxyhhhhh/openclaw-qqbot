import type { PluginRuntime } from "openclaw/plugin-sdk";
import { setOpenClawVersion } from "./bot-instance.js";

let runtime: PluginRuntime | null = null;

export function setQQBotRuntime(next: PluginRuntime) {
  runtime = next;
  // 将框架版本注入 User-Agent
  setOpenClawVersion(next.version);
}

export function getQQBotRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("QQBot runtime not initialized");
  }
  return runtime;
}
