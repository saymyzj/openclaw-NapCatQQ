---
name: napcat-ops
description: NapCat QQ 消息操作 — 发送文本、图片、文件、视频到 QQ 群或个人
---

# NapCat 消息操作

通过 NapCat (OneBot v11) 向 QQ 群聊或私聊发送消息。

## 发送文本

```bash
# 发到群聊
openclaw message send --channel napcat --to group:<群号> "消息内容"

# 发到私聊
openclaw message send --channel napcat --to user:<QQ号> "消息内容"

# QQ 号大于 1 亿时自动识别为私聊
openclaw message send --channel napcat --to <QQ号> "消息内容"
```

## 发送图片

```bash
# 本地图片
openclaw message send --channel napcat --to group:<群号> --media /path/to/image.png "图片说明"

# 远程图片 URL
openclaw message send --channel napcat --to group:<群号> --media https://example.com/image.jpg
```

AI 回复中的 `![](url)` 和裸图片 URL 也会自动提取为 QQ 原生图片发送。

## 发送文件

通过 Agent 工具调用 `napcat_send_file`：
- to: `group:<群号>` 或 `user:<QQ号>`
- file: 文件路径
- name: 文件名

## 发送视频

通过 Agent 工具调用 `napcat_send_video`：
- to: `group:<群号>` 或 `user:<QQ号>`
- video: 视频文件路径或 URL

## 目标格式

| 格式 | 说明 |
|------|------|
| `group:123456` | 群聊 |
| `user:654321` | 私聊 |
| `654321` | 自动判断：> 1 亿为私聊，否则为群聊 |
