# Release Notes

This file is meant as ready-to-use copy for GitHub Releases, repository introductions, or changelog summaries.

## Suggested GitHub Repository Description

OpenClaw plugin for NapCat QQ / OneBot v11 with @mention replies, monitored group patrol, planner pre-check, and QQ-native media sending.

## Suggested Topics

`openclaw`, `napcat`, `qq`, `onebot`, `onebot-v11`, `plugin`, `chatbot`, `typescript`

## Release Title

`v1.0.0 - First open source release`

## Release Body (English)

### Highlights

- NapCat (OneBot v11) channel plugin for OpenClaw
- QQ private chat and group chat support
- Instant reply when the bot is mentioned in any group
- Buffered group patrol with planner pre-check
- QQ-native text, image, video, and file sending
- Optional background group-memory summarization
- Conservative security defaults for public-facing chat agents

### Notes

- OpenClaw configuration is deployment-specific. Agent IDs, workspace paths, model IDs, and auth profiles in the README are examples only.
- For best results, use a dedicated low-privilege `chat` agent and a minimal `planner` agent.
- The planner pre-check uses OpenClaw gateway `/v1/chat/completions`, which is stateless per request but can still create one-shot session files.

### Recommended setup

- `main`: trusted/high-privilege workspace
- `chat`: read/search-only tools, no write/exec
- `planner`: no tools, no chat commands, minimal workspace

### Docs

- English: `README.md`
- 中文说明: `README.zh-CN.md`

## Release Body (中文)

### 亮点

- 基于 NapCat（OneBot v11）的 OpenClaw QQ 插件
- 支持 QQ 私聊和群聊
- 任意群里 `@` 机器人即可即时回复
- 白名单群支持缓冲巡检和 planner 预判
- 支持 QQ 原生文本、图片、视频、文件发送
- 支持后台群聊记忆压缩写入 Markdown
- 适合公开群聊场景的保守安全策略

### 说明

- OpenClaw 的配置高度因人而异，README 中的 agent ID、workspace 路径、模型名、auth profile 都只是示例。
- 推荐把 QQ 面向外部的能力拆成独立 `chat` agent 和独立 `planner` agent。
- planner 预判走的是 OpenClaw gateway 的 `/v1/chat/completions`，虽然是“每次请求独立上下文”，但依然可能生成一次性 session 文件。

### 推荐架构

- `main`：可信高权限工作区
- `chat`：只读/搜索类工具，不开写文件和执行命令
- `planner`：无工具、无聊天命令、极简工作区

### 文档

- English: `README.md`
- 中文说明：`README.zh-CN.md`
