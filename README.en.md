# OpenClaw NapCat QQ Plugin

Chinese is now the primary documentation for this repository and is shown on the GitHub homepage.

- Primary Chinese README: [README.md](./README.md)
- Chinese alias page: [README.zh-CN.md](./README.zh-CN.md)

## Scope

This plugin has been intentionally narrowed to a persona-first architecture:

- `persona-core` is the only formal QQ group conversation brain
- `voice-organ` is the only wording/surface organ
- the NapCat plugin is the world adapter, approval bridge, control-plane interceptor, and QQ-native delivery layer

Legacy compatibility for `chat`, `chat-brain`, `chat-surface`, and `planner` has been removed from the plugin path.

## Current Main Flow

`NapCat inbound -> persona-core runtime run -> voice-organ -> QQ outbound`

The plugin also:

- maintains canonical QQ-side message history
- keeps stable session routing for persona continuity
- reuses stable vision-side session keys for image understanding instead of creating a fresh image-analysis session per picture
- bridges `exec` approvals into NapCat private chat
- intercepts `/approve` and `/reflect` as control-plane messages
- stores reflection samples from `persona draft -> voice final`
- persists message-bound image cache entries so later follow-up questions can still re-open the original picture context

## Why This Repository Exists

The goal is no longer “a QQ bot that can reply”.

The goal is to give a persistent persona a real social surface with:

- runtime-native tool use
- session continuity
- approval-aware actions
- future self-reflection and memory evolution

## References and Thanks

- [openclaw/openclaw](https://github.com/openclaw/openclaw)
- [NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ)
- [botuniverse/onebot-v11](https://github.com/botuniverse/onebot-v11)

Thank you to the upstream projects and maintainers. This plugin stands on their work.

## Next Work

- better semantic stale-check heuristics for periodic patrol turns
- tighter long-term memory formatting conventions across shared daily-memory files
- more aggressive transcript-size controls for multimodal helper sessions
