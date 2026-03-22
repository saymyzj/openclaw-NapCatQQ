# v1.0.0 - First Open Source Release

## Highlights

- NapCat (OneBot v11) channel plugin for OpenClaw
- QQ private chat and group chat support
- Instant reply when the bot is mentioned in any group
- Buffered monitored-group patrol with planner pre-check
- QQ-native text, image, video, and file sending
- Optional background group-memory summarization
- Conservative security defaults for public-facing chat agents

## What This Plugin Does

`openclaw-napcat` connects QQ chats from NapCat into OpenClaw and supports two main group behaviors:

- immediate reply when the bot is `@`-mentioned
- silent buffering plus periodic patrol checks for monitored groups

The patrol flow can use a dedicated low-cost `planner` agent first, so the main chat agent only runs when the plugin decides a reply is actually needed.

## Security Model

This release is designed with public-facing chat safety in mind:

- recommended separate `main`, `chat`, and `planner` agents
- planner can be isolated with no tools and a minimal workspace
- chat can be limited to read/search-style tools only
- command-style QQ inputs such as `/status`, `/model`, `/reset`, and `!bash` can be blocked for selected agents

## Notes

- OpenClaw configuration is deployment-specific. Agent IDs, workspace paths, model IDs, auth profiles, and bindings shown in the README are examples only.
- Planner pre-check uses OpenClaw gateway `/v1/chat/completions`. It is stateless per request, but OpenClaw may still create one-shot planner session files.
- The plugin includes both English and Simplified Chinese documentation.

## Included Documentation

- English README: `README.md`
- 中文说明: `README.zh-CN.md`
- Changelog: `CHANGELOG.md`
- Contributing guide: `CONTRIBUTING.md`

## Recommended Setup

- `main`: trusted/high-privilege workspace
- `chat`: read/search-only tools, no write/exec
- `planner`: no tools, no chat commands, minimal workspace

## Repository

https://github.com/saymyzj/openclaw-NapCatQQ
