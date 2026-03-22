---
name: napcat-ops
description: NapCat QQ messaging operations — send text, images, videos, and files to QQ groups or direct chats through the napcat channel
---

# NapCat Messaging Ops

Use the `napcat` channel to send QQ messages through NapCat (OneBot v11).

Targets are user-specific. Replace placeholders such as `<QQ>` and `<GROUP>` with real IDs from your own deployment.

## Send Text

```bash
# group
openclaw message send --channel napcat --to group:<GROUP> "message"

# direct chat
openclaw message send --channel napcat --to user:<QQ> "message"

# bare numeric target
openclaw message send --channel napcat --to <QQ> "message"
```

Bare numeric targets are interpreted by the plugin as:

- user chat when the number is larger than `100000000`
- group chat otherwise

## Send Images

```bash
# local file
openclaw message send --channel napcat --to group:<GROUP> --media /path/to/image.png "caption"

# remote URL
openclaw message send --channel napcat --to group:<GROUP> --media https://example.com/image.jpg
```

The plugin also auto-extracts model output in these forms:

- `![](https://...)`
- bare image URL
- `<qqimg>https://...</qqimg>`

## Send Files

Use the NapCat file-send tool or the plugin's file-send path:

- `to`: `group:<GROUP>` or `user:<QQ>`
- `file`: local file path
- `name`: optional display name

The runtime may also parse:

- `<qqfile>/path/to/file</qqfile>`

## Send Videos

Use the NapCat video-send tool or the plugin's video-send path:

- `to`: `group:<GROUP>` or `user:<QQ>`
- `video`: local path or URL

The runtime may also parse:

- `<qqvideo>https://...</qqvideo>`

## Target Formats

| 格式 | 说明 |
|------|------|
| `group:123456` | 群聊 |
| `user:654321` | 私聊 |
| `654321` | 自动判断：> 1 亿为私聊，否则为群聊 |
