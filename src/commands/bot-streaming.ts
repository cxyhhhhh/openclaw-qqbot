import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import { getAdapters } from '../runtime-adapter/resolve.js';

/** /bot-streaming — 一键开关流式消息 */
export function botStreaming(account: ResolvedQQBotAccount, getRuntime: () => any): SlashCommand {
  return {
    name: 'bot-streaming',
    description: '一键开关流式消息',
    scope: 'c2c',
    usage: `/bot-streaming

查看当前流式消息状态，或切换开/关。
流式消息仅支持 C2C（私聊）场景。`,
    handler: async (ctx) => {
      const args = (Array.isArray(ctx.command.args) ? ctx.command.args.join(' ') : String(ctx.command.args ?? '')).trim().toLowerCase();
      const currentEnabled = account.config.streaming ?? false;

      // 无参数 → 显示状态
      if (!args) {
        const status = currentEnabled ? '✅ 已启用' : '❌ 未启用';
        const toggleHint = currentEnabled
          ? '<qqbot-cmd-input text="/bot-streaming off" show="关闭流式"/>'
          : '<qqbot-cmd-input text="/bot-streaming on" show="开启流式"/>';
        return [
          `🌊 流式消息状态: ${status}`,
          '',
          '流式消息仅支持 C2C（私聊）场景。',
          `点击 ${toggleHint} 切换。`,
        ].join('\n');
      }

      // on / off → 切换
      const targetEnabled = args === 'on' || args === '1' || args === 'true';
      if (targetEnabled === currentEnabled) {
        return `ℹ️ 流式消息已经是${currentEnabled ? '开启' : '关闭'}状态，无需切换。`;
      }

      // 通过 runtime adapter 持久化配置
      const runtime = getRuntime();
      if (!runtime) {
        return '⚠️ runtime 不可用，无法修改配置。';
      }

      const adapters = getAdapters(runtime);
      if (!adapters.persistConfig) {
        return '⚠️ 当前框架版本不支持在线修改配置，请手动编辑配置文件。';
      }

      try {
        await adapters.persistConfig((cfg: any) => {
          const qqbot = cfg.channels?.qqbot ?? {};
          qqbot.streaming = targetEnabled;
          if (!cfg.channels) cfg.channels = {};
          cfg.channels.qqbot = qqbot;
        });
        account.config.streaming = targetEnabled;
        return targetEnabled
          ? '✅ 流式消息已开启，私聊消息将以流式方式发送。'
          : '✅ 流式消息已关闭，私聊消息将以静态方式发送。';
      } catch (err) {
        return `⚠️ 配置修改失败：${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
