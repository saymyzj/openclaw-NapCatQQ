# Contributing

Thanks for your interest in improving `openclaw-napcat`.

This project is a NapCat (OneBot v11) channel plugin for OpenClaw. Contributions are welcome, especially around compatibility, reliability, safety, documentation, and media handling.

## Before You Start

- Read [README.md](./README.md) first
- If you target Chinese users, also read [README.zh-CN.md](./README.zh-CN.md)
- Keep in mind that OpenClaw is fast-moving, so compatibility changes may be caused by upstream runtime changes rather than this plugin alone

## Development Setup

```bash
git clone https://github.com/saymyzj/openclaw-NapCatQQ ~/.openclaw/extensions/napcat-qq
cd ~/.openclaw/extensions/napcat-qq
npm install
npm run build
```

Local requirements:

- Node.js `>=22`
- A local OpenClaw environment for end-to-end verification
- A NapCat instance if you want to test actual QQ message delivery

## Project Goals

When contributing, try to preserve these priorities:

- Keep public-facing chat surfaces low-risk
- Avoid surprising tool escalation on QQ-facing agents
- Keep planner logic lightweight and easy to isolate
- Preserve compatibility with OpenClaw routing/session conventions
- Prefer explicit documentation over hidden behavior

## Coding Guidelines

- Use TypeScript
- Keep edits ASCII unless the file already uses Chinese or other Unicode text intentionally
- Prefer simple, explicit logic over clever abstractions
- Avoid introducing hardcoded personal paths, tokens, QQ numbers, or model/account names
- Treat `main`, `chat`, and `planner` as examples, not universal assumptions

## Safety Guidelines

This plugin is often used on real chat surfaces. Please be conservative when changing:

- tool access
- planner routing
- private/group binding behavior
- command handling
- file writes
- media fetch and delivery

Changes that make public-facing agents more powerful should be documented clearly in the README and changelog.

## Testing

At minimum, before opening a PR:

```bash
npm run build
```

If your change affects runtime behavior, also test at least one of:

- private message dispatch
- group `@mention` reply
- monitored-group periodic check
- planner pre-check behavior
- media extraction and delivery
- routing/binding behavior

## Documentation

If you change behavior, please update the relevant docs:

- [README.md](./README.md)
- [README.zh-CN.md](./README.zh-CN.md)
- [CHANGELOG.md](./CHANGELOG.md)
- [RELEASE_NOTES.md](./RELEASE_NOTES.md) when release messaging changes materially

## Pull Requests

PRs are easier to review when they:

- solve one focused problem
- include a short motivation
- mention any OpenClaw version assumptions
- mention any security tradeoffs
- note whether the README or release notes were updated

Good PR summary format:

1. What changed
2. Why it changed
3. How it was verified
4. Any compatibility or security notes

## Reporting Issues

Bug reports are most helpful when they include:

- OpenClaw version
- NapCat version
- Node.js version
- relevant `openclaw.json` snippets with secrets removed
- relevant `[napcat]` log lines
- whether the issue is in private chat, group `@mention`, or periodic patrol flow
- whether planner/chat/main are separate agents in your setup

## Security

Please do not open a public issue for sensitive credentials, private chat logs, or exploitable security details with live tokens.

If you discover a dangerous issue involving:

- command bypass
- file write escalation
- routing into a privileged agent
- unintended tool exposure
- prompt injection leading to configuration damage

please report it privately to the maintainer first.
