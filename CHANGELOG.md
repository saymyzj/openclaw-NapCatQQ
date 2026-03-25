# Changelog

All notable changes to this project will be documented in this file.

The format loosely follows Keep a Changelog, adapted for a small plugin repository.

## [Unreleased]

### Added

- Persistent message-bound image cache entries in sqlite so quoted/replied images can be reopened after process restarts

### Changed

- Multimodal image-analysis requests now reuse stable vision session keys instead of scattering one-off transcripts per picture
- QQ-hosted image URLs now fall back to inline image payloads for `/v1/responses`, avoiding Gateway URL-block failures on NapCat media links
- Daily memory guidance now keeps one `memory/YYYY-MM-DD.md` file but requires explicit `## group_id: <id>` sections
- Daily memory heartbeat default is now 4 hours, and the startup 30-second bootstrap trigger has been removed
- Periodic patrol stale suppression now uses a lightweight heuristic: same-speaker follow-ups suppress stale replies, unrelated interleaving speakers do not

## [2.0.0] - 2026-03-25

### Added

- `persona-core -> voice-organ -> QQ outbound` 的正式 runtime 主链
- 统一的 reflection batch runner，以及带租约/错误信息的 reflection sample 状态
- 插件内 maintenance heartbeat，自动消费 reflection backlog
- 按“日期 + 群”增量沉淀的 daily memory pipeline
- 审批 followup 持久化 job、去重与重新 finalize 语义
- 重写后的中文主 README，覆盖原生 OpenClaw 安装、NapCat 配置、安全边界与核心框架

### Changed

- 群聊正式架构收敛为 `persona-core` 主脑与 `voice-organ` 表达器官
- 插件说明文档改为中文优先，并按独立人格运行时来组织
- 插件 manifest 配置说明已与当前真实实现对齐

### Removed

- 旧 `chat / chat-brain / chat-surface / planner` 群聊兼容方向的文档叙事
- 过时的 `preCheck*` 插件配置说明

### Security

- 强化了审批 followup 去重与持久化边界，降低异步重复发群风险
- 明确推荐 `voice-organ` 维持窄权限，不承担工具执行和高权限访问

## [1.0.0] - 2026-03-22

### Added

- NapCat (OneBot v11) channel integration for OpenClaw
- QQ private chat and group chat support
- Any-group `@mention` instant reply flow
- Whitelisted group buffering plus periodic patrol checks
- Dedicated planner pre-check flow through OpenClaw gateway `/v1/chat/completions`
- Native QQ image, video, and file delivery support
- Model-output parsing for `![](url)`, bare image URLs, `<qqimg>`, `<qqvideo>`, and `<qqfile>`
- Background group-memory summarizer that appends Markdown notes into `workspace-chat/memory`
- English and Simplified Chinese documentation
- MIT license

### Changed

- Route resolution now passes NapCat peer information into OpenClaw routing, improving binding accuracy
- Periodic group dispatch now preserves buffered context more reliably in session input fields
- Planner routing is agent-oriented via `preCheckAgentId`, reducing coupling to a hardcoded model string

### Security

- Added command-style input blocking for selected QQ-facing agents via `disableCommandsForAgents`
- Recommended planner isolation with no tools and a minimal workspace
- Recommended read/search-only tool policy for the public-facing `chat` agent
