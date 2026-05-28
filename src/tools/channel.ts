import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveQQBotAccount, listQQBotAccountIds } from "../config.js";
import { getBotForAccount } from "../bot-instance.js";

// ========== JSON Schema ==========

const ChannelApiSchema = {
  type: "object",
  properties: {
    method: {
      type: "string",
      description:
        "HTTP 请求方法。可选值：GET, POST, PUT, PATCH, DELETE",
      enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    },
    path: {
      type: "string",
      description:
        "API 路径（不含域名），占位符需替换为实际值。" +
        "示例：/users/@me/guilds, /guilds/{guild_id}/channels, /channels/{channel_id}",
    },
    body: {
      type: "object",
      description:
        "请求体（JSON），用于 POST/PUT/PATCH 请求。" +
        "GET/DELETE 请求不需要此参数。",
    },
    query: {
      type: "object",
      description:
        "URL 查询参数（键值对），会拼接到路径后面。" +
        "如 { \"limit\": \"100\", \"after\": \"0\" } 会拼接为 ?limit=100&after=0",
      additionalProperties: { type: "string" },
    },
  },
  required: ["method", "path"],
} as const;

// ========== 工具函数 ==========

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function validatePath(path: string): string | null {
  if (!path.startsWith("/")) return "path 必须以 / 开头";
  if (path.includes("..") || path.includes("//")) return "path 不允许包含 .. 或 //";
  if (!/^\/[a-zA-Z0-9\-._~:@!$&'()*+,;=/%]+$/.test(path) && path !== "/") {
    return "path 包含非法字符";
  }
  return null;
}

// ========== 注册入口 ==========

/**
 * 注册 QQ 频道 API 代理工具。
 * 使用 SDK 的 bot.api 网关替代自封装 HTTP — 自动鉴权、重试、结构化错误。
 */
export function registerChannelTool(api: OpenClawPluginApi): void {
  const cfg = api.config;
  if (!cfg) return;

  const accountIds = listQQBotAccountIds(cfg);
  if (accountIds.length === 0) return;

  const firstAccountId = accountIds[0];
  const account = resolveQQBotAccount(cfg, firstAccountId);
  if (!account.appId || !account.clientSecret) return;

  api.registerTool(
    {
      name: "qqbot_channel_api",
      label: "QQBot Channel API",
      description:
        "QQ 开放平台频道 API HTTP 代理，自动填充鉴权 Token。" +
        "常用接口速查：" +
        "频道列表 GET /users/@me/guilds | " +
        "子频道列表 GET /guilds/{guild_id}/channels | " +
        "子频道详情 GET /channels/{channel_id} | " +
        "创建子频道 POST /guilds/{guild_id}/channels | " +
        "成员列表 GET /guilds/{guild_id}/members?after=0&limit=100 | " +
        "成员详情 GET /guilds/{guild_id}/members/{user_id} | " +
        "帖子列表 GET /channels/{channel_id}/threads | " +
        "发帖 PUT /channels/{channel_id}/threads | " +
        "创建公告 POST /guilds/{guild_id}/announces | " +
        "创建日程 POST /channels/{channel_id}/schedules。" +
        "更多接口和参数详情请阅读 qqbot-channel skill。",
      parameters: ChannelApiSchema,
      async execute(_toolCallId, params) {
        const p = params as { method: string; path: string; body?: Record<string, unknown>; query?: Record<string, string> };

        if (!p.method) return json({ error: "method 为必填参数" });
        if (!p.path) return json({ error: "path 为必填参数" });

        const method = p.method.toUpperCase();
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
          return json({ error: `不支持的 HTTP 方法: ${method}` });
        }

        const pathError = validatePath(p.path);
        if (pathError) return json({ error: pathError });

        try {
          // 通过 SDK bot.api 网关发送请求（自动鉴权 + 超时 + 结构化错误）
          const bot = getBotForAccount(account.accountId);
          const apiGateway = bot.api;

          let data: unknown;
          switch (method) {
            case "GET":
              data = await apiGateway.get(p.path, p.query);
              break;
            case "POST":
              data = await apiGateway.post(p.path, p.body);
              break;
            case "PUT":
              data = await apiGateway.put(p.path, p.body);
              break;
            case "PATCH":
              data = await apiGateway.patch(p.path, p.body);
              break;
            case "DELETE":
              data = await apiGateway.delete(p.path);
              break;
          }

          return json(data);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // 从 ApiError 提取结构化信息
          const apiErr = err as { httpStatus?: number; bizCode?: number; path?: string };
          return json({
            error: errMsg,
            status: apiErr.httpStatus,
            code: apiErr.bizCode,
            path: p.path,
          });
        }
      },
    },
    { name: "qqbot_channel_api" },
  );

}
