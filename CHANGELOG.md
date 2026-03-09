# Changelog

## 1.5.5

1. 修复插件 id 与 package name 不匹配导致插件加载失败的问题。
2. 修复 normalizeTarget 返回值类型，改为结构化 {ok, to, error} 对象。
3. 脚本全面兼容多 CLI（openclaw / clawdbot / moltbot），自动检测配置文件路径。
4. 修复 pull-latest.sh、upgrade.sh 中过时的仓库地址引用。
5. upgrade-and-run.sh 增加首次运行缺少 AppID/Secret 时的明确提示。
6. upgrade-and-run.sh 增加 qqbot 插件更新前后版本号展示。
7. 修复 proactive-api-server.ts / send-proactive.ts 中硬编码的配置文件路径。
8. 修复 set-markdown.sh 中 read 缺少超时导致非交互环境挂起的问题。

## 1.5.4

1. 修复多账户并发时 Token 串号问题，按 appId 隔离缓存。
2. Token 后台刷新支持多实例，各账户独立管理。
3. 修复 `openclaw message send` 向非默认账户发消息失败的问题。
4. 新增多账户配置文档及调试日志增强。

## 1.5.3

1. 优化富媒体标签解析功能逻辑，提升识别成功率。
2. 解决了文件乱码，特殊路径问题。导致文件无法发送的问题。
3. 解决了偶现消息seq重复导致消息丢失问题。
4. 优化升级脚本功能：升级过程中自动备份并恢复 qqbot 通道配置；
5. 升级readme.md 增加富媒体消息使用说明及插件配置、升级教程。

## 1.5.2
- 新增语音/文件发送能力，支持 TTS 文字转语音
- 富媒体增强：上传缓存、视频支持、失败自动重试
- Markdown 消息默认开启
- 升级脚本独立化，支持用户选择启动方式（前台/后台）
