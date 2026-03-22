# OpenClaw NapCat QQ Plugin

NapCat (OneBot v11) channel plugin for OpenClaw.

- GitHub: <https://github.com/saymyzj/openclaw-NapCatQQ>
- Chinese README: [README.zh-CN.md](./README.zh-CN.md)
- Contributing: [CONTRIBUTING.md](./CONTRIBUTING.md)

This project connects QQ private chats and group chats to OpenClaw, supports `@`-mention replies, buffered group monitoring with planner pre-check, native QQ media delivery, and a conservative security model suitable for public or semi-public chat surfaces.

This repository is intended to be published as an MIT-licensed OpenClaw extension. The plugin integrates with OpenClaw's plugin/runtime interfaces, but your actual OpenClaw setup may differ. In particular, values such as agent IDs, workspace paths, model IDs, auth profiles, and session policy are user-specific and must be adjusted locally.

## Features

- Private chat support with optional QQ user allowlist
- Instant reply when the bot is `@`-mentioned in any group
- Monitored-group buffering and periodic AI intervention checks
- Dedicated planner pre-check flow via OpenClaw `/v1/chat/completions`
- Native QQ delivery for text, images, videos, and files
- Automatic extraction of `![](url)`, bare image URLs, and `<qqimg>/<qqvideo>/<qqfile>` tags from model replies
- Markdown-to-plain-text conversion for QQ-friendly rendering
- Buffered context stitching for monitored group replies
- Route-aware agent selection through OpenClaw bindings
- Optional background memory summarization that writes Markdown notes into `workspace-chat/memory`
- Command blocking for selected agents on QQ surfaces, to prevent `/status`, `/model`, `/reset`, `!bash`, etc. from being used from chat

## Compatibility

- OpenClaw: recent local gateway builds with plugin/channel runtime support
- NapCatQQ: OneBot v11 forward WebSocket mode
- Node.js: `>=22`

Because OpenClaw evolves quickly, you should verify any runtime-facing behavior against your installed OpenClaw version, especially:

- plugin SDK signatures
- routing/session behavior
- tool policy names
- command parsing behavior
- `/v1/chat/completions` gateway semantics

## Install

```bash
git clone https://github.com/saymyzj/openclaw-NapCatQQ ~/.openclaw/extensions/napcat-qq
cd ~/.openclaw/extensions/napcat-qq
npm install
npm run build
```

Then enable the plugin from your OpenClaw config and restart the gateway.

## What Is User-Specific

Do not copy these values blindly from examples in this repository:

- `agents.list[].id`
- `agents.list[].workspace`
- `agents.list[].agentDir`
- `agents.list[].model`
- `auth.profiles.*`
- `bindings[*].agentId`
- `bindings[*].match.peer.id`
- `channels.napcat.preCheckAgentId`
- `channels.napcat.disableCommandsForAgents`
- gateway token, WebSocket token, QQ numbers, group numbers

Examples in this README use placeholders such as `chat`, `main`, and `planner`, but your own OpenClaw instance may use different names entirely.

## Recommended OpenClaw Layout

This plugin works best when you separate responsibilities across agents:

- `main`: trusted direct-chat or high-privilege workspace
- `chat`: low-risk QQ-facing conversational workspace
- `planner`: ultra-minimal decision agent used only for pre-checking whether the bot should speak

A recommended security posture is:

- `planner`: no tools, no chat commands, tiny workspace, no memory/persona baggage
- `chat`: read/search-only tools, no write/edit/exec, no chat commands
- `main`: reserved for trusted/private routes only

## Example OpenClaw Config

This is an example, not a drop-in file.

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "main",
        "workspace": "/path/to/workspace",
        "agentDir": "/path/to/agents/main/agent",
        "model": "openai-codex/gpt-5.4"
      },
      {
        "id": "chat",
        "default": true,
        "workspace": "/path/to/workspace-chat",
        "agentDir": "/path/to/agents/chat/agent",
        "model": "openai-codex/gpt-5.4",
        "tools": {
          "allow": ["read", "web-search", "web-fetch", "memory-search", "memory-get"],
          "deny": ["exec", "write", "edit", "apply_patch"]
        }
      },
      {
        "id": "planner",
        "workspace": "/path/to/workspace-planner",
        "agentDir": "/path/to/agents/planner/agent",
        "model": "openai-codex/gpt-5.4",
        "tools": {
          "allow": [],
          "deny": [
            "exec",
            "read",
            "write",
            "edit",
            "apply_patch",
            "web-search",
            "web-fetch",
            "memory-search",
            "memory-get",
            "group:runtime",
            "group:fs",
            "group:ui",
            "group:messaging",
            "gateway",
            "nodes",
            "cron",
            "browser"
          ]
        }
      }
    ]
  },
  "bindings": [
    {
      "agentId": "main",
      "match": {
        "channel": "napcat",
        "peer": {
          "kind": "direct",
          "id": "user:1234567890"
        }
      }
    }
  ],
  "channels": {
    "napcat": {
      "host": "127.0.0.1",
      "port": 3001,
      "accessToken": "<napcat_access_token>",
      "path": "/",
      "monitorGroups": [123456789],
      "autoIntervene": true,
      "autoCheckIntervalMs": 30000,
      "autoCheckMessageThreshold": 10,
      "preCheckAgentId": "planner",
      "disableCommandsForAgents": ["chat", "planner"],
      "whitelistUserIds": ["1234567890"],
      "admins": ["1234567890"],
      "historyLimit": 100,
      "rateLimitMs": 1000,
      "renderMarkdownToPlain": true
    }
  },
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/extensions/napcat-qq"]
    },
    "entries": {
      "openclaw-napcat": {
        "enabled": true
      }
    }
  }
}
```

## NapCat Config

In NapCat WebUI, configure a forward WebSocket server:

- host: usually `0.0.0.0`
- port: for example `3001`
- path: `/`
- message format: `array` recommended
- access token: optional, but recommended when the gateway is not fully local

Then point `channels.napcat.host/port/path/accessToken` to that endpoint.

## Channel Config

The plugin reads `channels.napcat` from `openclaw.json`.

### Supported Fields

| Field | Type | Default | Notes |
|---|---|---:|---|
| `host` | `string` | `127.0.0.1` | NapCat WebSocket host |
| `port` | `number` | `3001` | NapCat WebSocket port |
| `accessToken` | `string` | - | NapCat access token |
| `path` | `string` | `/` | WebSocket path |
| `monitorGroups` | `number[]` | `[]` | Groups eligible for buffered periodic checks |
| `autoIntervene` | `boolean` | `true` | Enable monitored-group periodic checks |
| `autoIntervenePrompt` | `string` | - | Extra planner guidance |
| `autoCheckIntervalMs` | `number` | `30000` | Timer-based patrol interval |
| `autoCheckMessageThreshold` | `number` | `10` | Buffered-message threshold |
| `preCheckAgentId` | `string` | `planner` | OpenClaw agent used for pre-check |
| `preCheckModel` | `string` | - | Optional override still used by background summarizer; pre-check routing is better controlled via `preCheckAgentId` |
| `requireMention` | `boolean` | `false` | Mention gating helper for some reply flows |
| `historyLimit` | `number` | `20` | Pending in-memory history window |
| `rateLimitMs` | `number` | `1000` | Delay between sends |
| `renderMarkdownToPlain` | `boolean` | `true` | Convert Markdown before sending |
| `whitelistUserIds` | `Array<string|number>` | `[]` | Private-chat allowlist |
| `admins` | `Array<string|number>` | `[]` | Reserved admin IDs for local policy logic |
| `disableCommandsForAgents` | `string[]` | `["chat","planner"]` | Block `/...` and `!...` for selected routed agents |

### Environment Variables

Only connection basics can be sourced from environment variables:

```bash
export NAPCAT_WS_HOST=127.0.0.1
export NAPCAT_WS_PORT=3001
export NAPCAT_WS_ACCESS_TOKEN=your_token
export NAPCAT_WS_PATH=/
```

Behavioral settings such as monitored groups, planner agent, and command blocking still belong in OpenClaw config.

## Message Flow

### Group Message

1. Receive a group message
2. Record it into the local message buffer database
3. If the bot is mentioned, dispatch immediately
4. Otherwise, if the group is monitored, buffer and wait for:
   - message threshold reached, or
   - timer-triggered periodic check
5. Send the buffered slice to the planner agent
6. If planner says `reply`, dispatch buffered context to the routed chat agent
7. If planner says `silence`, keep quiet and only advance the checkpoint for the processed slice

### Private Message

1. Receive a private message
2. Apply `whitelistUserIds` if configured
3. Resolve target agent via OpenClaw routing/bindings
4. Optionally block command-style input for protected agents
5. Dispatch to OpenClaw

## Routing Notes

This plugin uses OpenClaw route resolution, and private/group traffic may land in different agents depending on:

- default agent
- `bindings`
- `session.dmScope`
- peer match shape such as `user:<qq>` or `group:<groupId>`
- existing session routing metadata

If you use bindings, verify them against your own OpenClaw version and your chosen peer format.

Example direct-message binding:

```jsonc
{
  "bindings": [
    {
      "agentId": "main",
      "match": {
        "channel": "napcat",
        "peer": {
          "kind": "direct",
          "id": "user:1234567890"
        }
      }
    }
  ]
}
```

## Planner Sessions

The planner pre-check uses OpenClaw gateway `POST /v1/chat/completions`.

Important:

- this is stateless-per-request, not no-session-at-all
- OpenClaw may still create one-shot session files for planner requests
- those session files are expected under the planner agent's session store

If you want low cost and easy cleanup:

- keep planner in its own agent
- give it a minimal workspace
- clean only the planner session store

## Command Blocking

For QQ-facing agents such as `chat` and `planner`, this plugin can block OpenClaw command-style messages before they enter the normal command pipeline.

Blocked examples:

- `/status`
- `/model`
- `/reset`
- `/new`
- `!bash ls`

This is controlled by `channels.napcat.disableCommandsForAgents`.

## Media Handling

The plugin supports:

- plain text
- native QQ image sends
- native QQ video sends
- native QQ file uploads

Model replies can include:

- Markdown images: `![](https://example.com/a.png)`
- bare image URLs
- `<qqimg>...</qqimg>`
- `<qqvideo>...</qqvideo>`
- `<qqfile>...</qqfile>`

The plugin extracts these payloads and sends them through NapCat's QQ-native media APIs.

## Memory Summarization

The plugin includes a background summarizer that periodically:

- reads unsummarized buffered group messages
- calls the OpenClaw gateway
- appends a short summary into `workspace-chat/memory/<date>.md`

This write path is performed by the plugin process itself, not by granting the `chat` agent file-write tools.

That means you can keep the `chat` agent read-only while still preserving group-summary notes.

## Security Recommendations

- Do not expose a high-privilege coding agent directly to public group chats
- Keep `planner` tool-less
- Keep `chat` read/search-only unless you fully trust the surface
- Disable QQ-side command access for public-facing agents
- Avoid reusing your primary workspace for monitored groups
- Do not publish your real tokens, QQ numbers, absolute home paths, or auth profile names

## Development

```bash
npm install
npm run build
npm run dev
```

CI is configured via GitHub Actions in [ci.yml](./.github/workflows/ci.yml).

## Project Structure

```text
extensions/napcat-qq/
├── src/
│   ├── index.ts
│   ├── channel.ts
│   ├── service.ts
│   ├── connection.ts
│   ├── send.ts
│   ├── config.ts
│   ├── types.ts
│   ├── message.ts
│   ├── markdown.ts
│   ├── precheck.ts
│   ├── memory-job.ts
│   ├── sdk.ts
│   ├── reply-context.ts
│   └── handlers/
│       ├── process-inbound.ts
│       └── auto-intervene.ts
├── skills/
│   └── napcat-ops/
│       └── SKILL.md
├── openclaw.plugin.json
├── package.json
└── README.md
```

## MIT License

This project is released under the MIT License. See [LICENSE](./LICENSE).

## OpenClaw Attribution

This plugin depends on OpenClaw runtime APIs and is designed for OpenClaw deployments. OpenClaw itself is a separate upstream project with its own release cycle, documentation, and compatibility expectations.
