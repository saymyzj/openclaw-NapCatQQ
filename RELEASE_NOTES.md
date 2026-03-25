# Release Notes

This file is meant as ready-to-use copy for GitHub Releases, repository introductions, or changelog summaries.

## Suggested GitHub Repository Description

OpenClaw 的 NapCat QQ 插件 / OpenClaw NapCat QQ plugin，独立人格主链、审批桥接、reflection 与 daily memory。

## Suggested Topics

`openclaw`, `napcat`, `qq`, `onebot`, `onebot-v11`, `plugin`, `chatbot`, `typescript`

## Release Title

`v2.0.0.0 - Persona runtime release`

## Release Body (English)

### Highlights

- NapCat (OneBot v11) plugin for OpenClaw with a persona-first runtime architecture
- `persona-core` is the only formal QQ group brain
- `voice-organ` is the only surface organ for naturalized wording
- Approval-aware async followup routing with dedupe protection
- Automatic reflection backlog processing and daily memory ingestion
- Rewritten deployment docs from OpenClaw install to NapCat configuration and risk boundaries

### Notes

- OpenClaw configuration remains deployment-specific. Agent IDs, workspace paths, model IDs, and auth profiles in the README are examples only.
- The recommended setup is now `main + persona-core + voice-organ`, not the previous `chat + planner` split.
- The GitHub release tag can be `v2.0.0.0`, while repository package metadata remains semver-compatible as `2.0.0`.

### Recommended setup

- `main`: trusted/high-privilege workspace
- `persona-core`: the only formal QQ group brain with approval-gated tools when needed
- `voice-organ`: no tools, no read/write, only wording/surface work

### Docs

- 中文主文档: `README.md`
- Chinese alias: `README.zh-CN.md`
- English overview: `README.en.md`

## Release Body (中文)

### 亮点

- 基于 NapCat（OneBot v11）的 OpenClaw QQ 插件
- 正式群聊主链收敛为 `persona-core -> voice-organ -> QQ outbound`
- 审批后的异步补结果支持持久化、去重与重新 finalize
- 自动 reflection backlog 与 daily memory 增量沉淀已接入维护循环
- README 已重写为从 OpenClaw 安装到 NapCat 配置的一条龙文档

### 说明

- OpenClaw 的配置高度因人而异，README 中的 agent ID、workspace 路径、模型名、auth profile 都只是示例。
- 当前推荐架构是 `main + persona-core + voice-organ`，不再推荐旧 `chat + planner` 长期并存。
- GitHub Release 可以发布为 `v2.0.0.0`，仓库内 package 元数据保持兼容的 `2.0.0`。

### 推荐架构

- `main`：可信高权限工作区
- `persona-core`：唯一正式群聊主脑，必要时可走审批工具
- `voice-organ`：唯一表达器官，保持窄权限

### 文档

- 中文文档：`README.md`
- English overview：`README.en.md`
