# qqbot 插件升级说明

## 当前阶段（独立插件）

- 一键升级:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/tencent-connect/openclaw-qqbot/main/scripts/upgrade-via-npm.sh | bash
  ```
- 指定版本: `/qqbot-upgrade <版本号>`
- 手动升级:
  ```bash
  openclaw plugins install @tencent-connect/openclaw-qqbot@latest
  ```

## openclaw 合入后（内置插件）

```bash
openclaw upgrade
# 或
openclaw plugins install @tencent-connect/openclaw-qqbot@latest
```
