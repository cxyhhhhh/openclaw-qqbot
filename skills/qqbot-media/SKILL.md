---
name: qqbot-media
description: QQBot 图片收发能力。用户发来的图片自动下载到本地，发送图片使用 <qqimg> 标签。当通过 QQ 通道通信时使用此技能。
metadata: {"openclaw":{"emoji":"📸","requires":{"config":["channels.qqbot"]}}}
---

# QQBot 图片收发

## 发送图片

使用 `<qqimg>` 标签包裹路径即可发送图片（本地路径或网络 URL）：

```
<qqimg>/path/to/image.jpg</qqimg>
<qqimg>https://example.com/image.png</qqimg>
```

支持格式：jpg, jpeg, png, gif, webp, bmp。支持 `</qqimg>` 或 `</img>` 闭合。

## 接收图片

用户发来的图片**自动下载到本地**，路径在上下文【会话上下文 → 附件】中。
可直接用 `<qqimg>路径</qqimg>` 回发。历史图片在 `~/.openclaw/qqbot/downloads/` 下。

## 规则

- **永远不要说**"无法发送图片"或"无法访问之前的图片"
- 直接使用 `<qqimg>` 标签，不要只输出路径文本
- 标签外的文字会作为消息正文一起发送
- 多张图片使用多个 `<qqimg>` 标签

## JSON 结构化载荷（高级）

```
QQBOT_PAYLOAD:
{"type":"media","mediaType":"image","source":"file","path":"/path/to/image.jpg","caption":"可选描述"}
```
