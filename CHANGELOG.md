# Changelog

All notable changes to this project will be documented in this file.

The format loosely follows Keep a Changelog, adapted for a small plugin repository.

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
