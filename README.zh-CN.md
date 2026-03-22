# OpenClaw NapCat QQ 插件

NapCat（OneBot v11）的 OpenClaw QQ 频道插件。

- GitHub：<https://github.com/saymyzj/openclaw-NapCatQQ>
- English README: [README.md](./README.md)
- 贡献说明：[CONTRIBUTING.md](./CONTRIBUTING.md)

这个插件用于把 QQ 私聊和群聊接入 OpenClaw，支持 `@` 机器人即时回复、白名单群缓冲巡检、独立 planner 预判、QQ 原生图片/视频/文件发送，以及适合公开群聊场景的保守安全策略。

本仓库计划以 MIT 协议开源。插件依赖 OpenClaw 的插件运行时和网关接口，但每个人的 OpenClaw 环境都不一样，所以文档中的很多示例都只能作为参考，不能直接照抄。

## 主要功能

- 支持 QQ 私聊，可选白名单限制
- 任意群聊中 `@` 机器人后即时回复
- 白名单群消息缓冲后，按阈值或定时器触发巡检
- 通过独立 `planner` agent 先判断“要不要回复”
- 支持文本、图片、视频、文件的 QQ 原生发送
- 自动提取模型输出中的图片 URL、`![](url)`、`<qqimg>/<qqvideo>/<qqfile>` 标签
- 自动把 Markdown 转成更适合 QQ 显示的纯文本
- 在巡检回复时拼接缓冲的群聊上下文
- 通过 OpenClaw routing/bindings 把不同会话分流到不同 agent
- 可选后台群聊记忆压缩，把摘要写入 `workspace-chat/memory/*.md`
- 可对特定 agent 禁止 QQ 侧 `/...`、`!...` 命令输入

## 兼容性

- OpenClaw：支持插件/频道运行时的较新版本
- NapCatQQ：OneBot v11 正向 WebSocket 模式
- Node.js：`>=22`

OpenClaw 迭代很快，下面这些行为建议你以自己的本地版本为准：

- plugin SDK 签名
- routing / session 行为
- tool policy 名称
- command 解析行为
- `/v1/chat/completions` 的网关语义

## 安装

```bash
git clone https://github.com/saymyzj/openclaw-NapCatQQ ~/.openclaw/extensions/napcat-qq
cd ~/.openclaw/extensions/napcat-qq
npm install
npm run build
```

之后在 `openclaw.json` 里启用插件，并重启 OpenClaw gateway。

## 哪些配置因人而异

下面这些值通常都要按你自己的环境修改，不要直接照搬：

- `agents.list[].id`
- `agents.list[].workspace`
- `agents.list[].agentDir`
- `agents.list[].model`
- `auth.profiles.*`
- `bindings[*].agentId`
- `bindings[*].match.peer.id`
- `channels.napcat.preCheckAgentId`
- `channels.napcat.disableCommandsForAgents`
- 网关 token、NapCat token、QQ 号、群号

README 中常用 `main`、`chat`、`planner` 作为示例，但你的 OpenClaw 完全可以用别的 agent 名称。

## 推荐的 OpenClaw 架构

这个插件比较适合把职责拆开：

- `main`：高权限、可信私聊工作区
- `chat`：面向 QQ 的低风险聊天工作区
- `planner`：只负责“是否回复”的极简预判 agent

推荐的安全边界：

- `planner`：无工具、无聊天命令、极小 workspace、不要人格记忆
- `chat`：只读/搜索类工具，不给写文件/执行命令，不允许聊天命令
- `main`：只给可信私聊或明确绑定的高权限入口

## OpenClaw 配置示例

这是示例，不是可直接粘贴的最终配置。

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

## NapCat 侧配置

在 NapCat WebUI 中配置 OneBot v11 正向 WebSocket：

- host：通常填 `0.0.0.0`
- port：例如 `3001`
- path：通常 `/`
- message format：推荐 `array`
- access token：可选，但如果不是纯本地链路，建议开启

然后在 OpenClaw 的 `channels.napcat.host/port/path/accessToken` 中指向这个端点。

## 频道配置项

插件读取 `openclaw.json` 中的 `channels.napcat`。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---:|---|
| `host` | `string` | `127.0.0.1` | NapCat WebSocket 主机 |
| `port` | `number` | `3001` | NapCat WebSocket 端口 |
| `accessToken` | `string` | - | NapCat access token |
| `path` | `string` | `/` | WebSocket 路径 |
| `monitorGroups` | `number[]` | `[]` | 允许进行缓冲巡检的群 |
| `autoIntervene` | `boolean` | `true` | 是否启用白名单群定期巡检 |
| `autoIntervenePrompt` | `string` | - | 额外的 planner 提示 |
| `autoCheckIntervalMs` | `number` | `30000` | 定时巡检间隔 |
| `autoCheckMessageThreshold` | `number` | `10` | 缓冲消息阈值 |
| `preCheckAgentId` | `string` | `planner` | 用于预判的 OpenClaw agent |
| `preCheckModel` | `string` | - | 可选字段，目前更推荐通过 `preCheckAgentId` 来控制预判模型 |
| `requireMention` | `boolean` | `false` | 某些回复路径下的 mention gate 辅助项 |
| `historyLimit` | `number` | `20` | 内存中的待发历史条数 |
| `rateLimitMs` | `number` | `1000` | 发送节流 |
| `renderMarkdownToPlain` | `boolean` | `true` | 是否把 Markdown 转纯文本 |
| `whitelistUserIds` | `Array<string\|number>` | `[]` | 私聊白名单 |
| `admins` | `Array<string\|number>` | `[]` | 管理员 ID 列表 |
| `disableCommandsForAgents` | `string[]` | `["chat","planner"]` | 对这些 agent 路由禁用 `/...`、`!...` 命令风格输入 |

### 环境变量

只有基础连接参数支持环境变量：

```bash
export NAPCAT_WS_HOST=127.0.0.1
export NAPCAT_WS_PORT=3001
export NAPCAT_WS_ACCESS_TOKEN=your_token
export NAPCAT_WS_PATH=/
```

像 monitored groups、planner agent、命令拦截这类行为配置仍然建议写在 `openclaw.json`。

## 消息处理流程

### 群聊

1. 收到群消息
2. 写入本地消息缓冲数据库
3. 如果被 `@`，立即回复
4. 否则，如果该群在 `monitorGroups` 中，则继续缓存
5. 到达消息阈值或定时器到期时，触发巡检
6. 先把当前缓冲消息送给 `planner`
7. 如果 `planner` 判定需要回复，则把缓冲上下文送给聊天 agent
8. 如果 `planner` 判定不需要回复，则静默并推进 checkpoint

### 私聊

1. 收到私聊消息
2. 如果配置了 `whitelistUserIds`，先做白名单判断
3. 通过 OpenClaw routing / bindings 解析目标 agent
4. 如果目标 agent 在命令禁用名单里，则先拦截 `/...` 和 `!...`
5. 正常分发给 OpenClaw

## 路由说明

这个插件会走 OpenClaw 的 route resolution，所以私聊/群聊最终进入哪个 agent，和下面这些因素有关：

- default agent
- `bindings`
- `session.dmScope`
- peer 匹配格式，例如 `user:<qq>`、`group:<groupId>`
- 已存在的 session 路由元数据

如果你启用了 bindings，请根据自己的 OpenClaw 版本和 peer 格式来验证。

私聊绑定示例：

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

## Planner Sessions 说明

planner 预判目前走的是 OpenClaw gateway 的 `POST /v1/chat/completions`。

需要注意：

- 这是“每次请求独立 session”，不是“完全不落 session”
- OpenClaw 仍然可能为 planner 请求生成一次性 session 文件
- 这些文件通常会出现在 planner agent 自己的 `sessions/` 目录下

如果你想让成本低、清理方便，建议：

- 把 planner 单独放成一个 agent
- 给它最小 workspace
- 清理时只清 planner 的 session store

## QQ 侧命令拦截

对于 `chat`、`planner` 这类面向 QQ 的 agent，可以在插件入口直接拦截 OpenClaw 命令风格输入，避免走到命令管线里。

典型被拦截的输入包括：

- `/status`
- `/model`
- `/reset`
- `/new`
- `!bash ls`

这个行为由 `channels.napcat.disableCommandsForAgents` 控制。

## 媒体处理

插件支持：

- 文本
- QQ 原生图片
- QQ 原生视频
- QQ 文件上传

模型输出里可以包含：

- Markdown 图片：`![](https://example.com/a.png)`
- 裸图片 URL
- `<qqimg>...</qqimg>`
- `<qqvideo>...</qqvideo>`
- `<qqfile>...</qqfile>`

插件会自动提取这些内容，并通过 NapCat 的 QQ 原生接口发送。

## 后台记忆压缩

插件包含一个后台摘要器，会定期：

- 读取尚未总结的群消息
- 通过 OpenClaw gateway 生成摘要
- 把摘要追加到 `workspace-chat/memory/<date>.md`

这里的写入是插件进程自己执行的，不依赖给 `chat` agent 开写文件工具。

所以你可以保持 `chat` 只读，同时仍然保留群聊摘要记忆。

## 安全建议

- 不要把高权限 coding agent 直接暴露给公开群聊
- `planner` 保持无工具
- `chat` 尽量只给读取/搜索类能力
- 对公开 QQ 会话禁用聊天命令
- 不要复用你的主 workspace 给公开群聊
- 不要把真实 token、QQ 号、绝对路径、auth profile 名直接写进公开仓库

## 开发

```bash
npm install
npm run build
npm run dev
```

GitHub Actions 自动构建配置位于 [ci.yml](./.github/workflows/ci.yml)。

## 目录结构

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
└── README.zh-CN.md
```

## MIT 协议

本项目采用 MIT License，详见 [LICENSE](./LICENSE)。

## 关于 OpenClaw

本插件依赖 OpenClaw 的运行时接口和网关能力。OpenClaw 本身是独立的上游项目，有自己的版本节奏、文档和兼容性要求。
