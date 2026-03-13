---
name: napcat-ops
description: NapCat QQ 消息操作 — 发送消息、图片、文件、视频到 QQ 群或个人
---

# NapCat 消息操作

通过 NapCat (OneBot v11) 向 QQ 群聊或私聊发送消息。

## 发送文本
```
openclaw message send --channel napcat --to group:<群号> "消息内容"
openclaw message send --channel napcat --to user:<QQ号> "消息内容"
```

## 发送图片
```
openclaw message send --channel napcat --to group:<群号> --media /path/to/image.png "图片说明"
```

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
- `group:123456` — 群聊
- `user:654321` 或 `654321` — 私聊（QQ号大于1亿自动识别为用户）
