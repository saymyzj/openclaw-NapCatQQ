# OpenClaw NapCat QQ 插件

NapCat（OneBot v11）到 OpenClaw 的 QQ 频道插件。

它的目标不是“给 QQ 接一个普通聊天机器人”，而是把 QQ 群聊接入一条稳定的、可审批、可反思、可沉淀记忆的 runtime 主链，让 `persona-core` 作为独立人格长期运行，`voice-organ` 作为唯一表达器官负责自然化输出。

- GitHub：<https://github.com/saymyzj/openclaw-NapCatQQ>
- English README: [README.en.md](./README.en.md)
- 贡献说明：[CONTRIBUTING.md](./CONTRIBUTING.md)

## 亮点

- 独立人格：QQ群聊主脑不是一次性 prompt，而是长期存在的 `persona-core`
- runtime-first：正式主链走 OpenClaw runtime，不把 QQ 主链退回到临时 `/v1/chat/completions`
- 双层表达：`persona-core` 决定“说什么”，`voice-organ` 决定“怎么说”
- 审批闭环：高风险 `exec` 会走 OpenClaw 原生审批，再通过 NapCat 回到管理员私聊
- 记忆闭环：插件维护 world ledger，reflection 和 daily memory 交给人格体自己吸收

## 致谢

本插件参考了麦麦聊天机器人项目 MaiBot，在“面向真实社群关系的聊天机器人”这条方向上受益很多，特此致谢：

- MaiBot：<https://github.com/Mai-with-u/MaiBot>

## 这个插件是什么

这个插件负责五件事：

1. 把 NapCat / QQ 世界接到 OpenClaw
2. 把群聊真实历史沉淀为 canonical ledger
3. 把正式群聊回合稳定路由到 `persona-core -> voice-organ`
4. 把审批、控制面和异步补结果纳入同一个运行时边界
5. 给 reflection 与 daily memory 提供样本和维护入口


正式群聊主链只有一条：

`NapCat inbound -> persona-core runtime run -> voice-organ -> QQ outbound`

## 核心框架

### 1. 主链

- `persona-core`：唯一正式群聊主脑，决定是否说话以及核心意思
- `voice-organ`：唯一表达器官，把核心意思改写得更自然，但不新增事实
- NapCat 插件：世界适配层、canonical ledger、控制面入口、审批桥接层

### 2. 三层记忆

- canonical ledger：插件维护，保存“世界真相”
  内容包括群消息、图片摘要、最终发出的机器人消息、reply anchor、engagement state
- agent session：OpenClaw runtime 维护，保存人格连续性
  内容包括最近几轮内部理解、工具调用、system events
- reflection / daily memory：位于两者之间
  用来把真实聊天样本逐步沉淀为人格自己的可吸收材料

### 3. 控制面

- `/approve ...`：管理员私聊入口，用于处理 `exec` 审批
- `/reflect [groupId] [limit]`：管理员私聊入口，用于手动触发 reflection
- 插件会在普通聊天流之前拦截这些命令，避免污染正式会话

### 4. 维护循环

- 自动 reflection：后台 heartbeat 批量消费 pending reflection samples
- daily memory：后台 heartbeat 按“日期 + 群”增量沉淀 `memory/YYYY-MM-DD.md`
- async followup：审批完成后的结果先进入 followup job，再尽量回到 persona/voice 语义

## 从零开始安装

下面这套流程按“原生 OpenClaw + NapCat + 本插件”来写，目标是从头到尾跑通。

### 0. 前置条件

你至少需要准备好：

- 一套可运行的 OpenClaw
- Node.js `>= 22`
- 一个可正常登录 QQ 的 NapCat 环境
- 一个用来收审批和控制面消息的管理员 QQ
- 至少 3 个 OpenClaw agent：
  `main`、`persona-core`、`voice-organ`

如果你只装插件、不准备 `persona-core / voice-organ`，插件当然能被加载，但你得不到这套“独立人格主链”的核心价值。

### 1. 配置 NapCat

先在 NapCat 侧完成 QQ 登录，并启用 OneBot v11 WebSocket 服务。

你需要确认这几个信息：

- `host`
  推荐 `127.0.0.1`
- `port`
  例如 `3001`
- `path`
  默认 `/`
- `access token`
  强烈建议设置，不要裸奔

推荐做法：

- 让 NapCat 只监听本机回环地址
- 如果 OpenClaw 与 NapCat 不在同一台机器上，只通过受控内网、Tailscale 或反向代理暴露
- 不要把 NapCat WebSocket 直接暴露到公网

### 2. 准备 OpenClaw agent 结构

推荐保留三个主体：

- `main`
  负责可信私聊、控制面、日常维护
- `persona-core`
  负责正式群聊人格回合、reflection、daily memory 写入
- `voice-organ`
  负责群聊表达润色，不应该拥有读写/exec 等高权限工具

推荐目录布局：

```text
~/.openclaw/
  agents/
    main/
    persona-core/
    voice-organ/
  workspace/
  workspace-persona-core/
  workspace-voice-organ/
  extensions/
    napcat-qq/
```

### 3. 拉取并构建插件

```bash
mkdir -p ~/.openclaw/extensions
git clone https://github.com/saymyzj/openclaw-NapCatQQ ~/.openclaw/extensions/napcat-qq
cd ~/.openclaw/extensions/napcat-qq
npm install
npm run build
```

### 4. 用原生 OpenClaw 安装插件

原生安装方式优先推荐：

```bash
openclaw plugins install -l ~/.openclaw/extensions/napcat-qq
```

这个命令通常会把插件写进你的 `openclaw.json` 的 `plugins` 段，包括：

- `plugins.allow`
- `plugins.load.paths`
- `plugins.entries`
- `plugins.installs`

如果你更喜欢手动管理，也可以自己编辑 `openclaw.json`，但推荐先让原生命令落一版，再按需微调。

### 5. 配置 `openclaw.json`

下面是一份推荐的单账号配置形态。它不是最小配置，而是更接近“独立人格运行时”的实际部署配置。

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "/path/to/workspace",
        "agentDir": "/path/to/agents/main/agent",
        "model": "openai-codex/gpt-5.4"
      },
      {
        "id": "persona-core",
        "workspace": "/path/to/workspace-persona-core",
        "agentDir": "/path/to/agents/persona-core/agent",
        "model": "openai-codex/gpt-5.4",
        "tools": {
          "allow": [
            "read",
            "write",
            "edit",
            "apply_patch",
            "exec",
            "web_fetch",
            "memory_search",
            "memory_get"
          ],
          "exec": {
            "host": "gateway",
            "security": "allowlist",
            "ask": "on-miss"
          }
        }
      },
      {
        "id": "voice-organ",
        "workspace": "/path/to/workspace-voice-organ",
        "agentDir": "/path/to/agents/voice-organ/agent",
        "model": "openrouter/bytedance-seed/seed-2.0-mini",
        "tools": {
          "allow": [],
          "deny": [
            "exec",
            "read",
            "write",
            "edit",
            "apply_patch",
            "web_search",
            "web_fetch",
            "memory_search",
            "memory_get",
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
  "approvals": {
    "exec": {
      "enabled": true,
      "mode": "targets",
      "agentFilter": ["persona-core"],
      "targets": [
        {
          "channel": "napcat",
          "to": "napcat:1234567890"
        }
      ]
    }
  },
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
      "historyLimit": 100,
      "rateLimitMs": 1000,
      "renderMarkdownToPlain": true,
      "multimodalImagesEnabled": true,
      "multimodalImageMaxCount": 3,
      "whitelistUserIds": ["1234567890"],
      "admins": ["1234567890"],
      "persona": {
        "enabled": true,
        "coreAgentId": "persona-core",
        "voiceAgentId": "voice-organ",
        "voiceOnGroupOnly": true
      },
      "maintenance": {
        "enabled": true,
        "reflectionEnabled": true,
        "reflectionIntervalMs": 300000,
        "reflectionBatchSize": 5,
        "dailyMemoryEnabled": true,
        "dailyMemoryIntervalMs": 900000,
        "dailyMemoryBatchSize": 2
      },
      "disableCommandsForAgents": ["persona-core", "voice-organ"]
    }
  }
}
```

### 6. 重启 OpenClaw / Gateway

完成配置后，重启 OpenClaw gateway。插件正常加载时，你应该能在日志里看到：

```text
[plugins] [napcat] plugin loaded
```

## 配置参数说明

下面这一节以 `channels.napcat` 为准。

### 基础连接

| 参数 | 是否必需 | 说明 |
| --- | --- | --- |
| `host` | 是 | NapCat WebSocket 地址，通常是 `127.0.0.1` |
| `port` | 是 | NapCat WebSocket 端口 |
| `accessToken` | 强烈建议 | NapCat 访问令牌 |
| `path` | 否 | WebSocket 路径，默认 `/` |

### 群聊行为

| 参数 | 是否必需 | 说明 |
| --- | --- | --- |
| `monitorGroups` | 否 | 白名单群号列表；这些群会启用 periodic patrol |
| `autoIntervene` | 否 | 是否启用白名单群自动巡检 |
| `autoCheckIntervalMs` | 否 | 巡检间隔，默认 `30000` |
| `autoCheckMessageThreshold` | 否 | 累积消息阈值，默认 `10` |
| `requireMention` | 否 | 是否强制只有被 `@` 时才立即处理 |
| `historyLimit` | 否 | 插件侧历史上下文保留条数 |
| `rateLimitMs` | 否 | 发送节流，避免 QQ 侧限流 |

### 多模态与输出

| 参数 | 是否必需 | 说明 |
| --- | --- | --- |
| `renderMarkdownToPlain` | 否 | 是否把 Markdown 压成纯文本再发 QQ |
| `multimodalImagesEnabled` | 否 | 是否开启图片摘要 / 问图能力 |
| `multimodalImageMaxCount` | 否 | 单轮最多处理几张图片 |

### 人格主链

| 参数 | 是否必需 | 说明 |
| --- | --- | --- |
| `persona.enabled` | 否 | 是否启用人格主链 |
| `persona.coreAgentId` | 否 | 正式群聊主脑，默认 `persona-core` |
| `persona.voiceAgentId` | 否 | 表达器官，默认 `voice-organ` |
| `persona.voiceOnGroupOnly` | 否 | 是否仅在群聊使用 `voice-organ` |

### 自动维护

| 参数 | 是否必需 | 说明 |
| --- | --- | --- |
| `maintenance.enabled` | 否 | 是否启用后台维护循环 |
| `maintenance.reflectionEnabled` | 否 | 是否自动跑 reflection backlog |
| `maintenance.reflectionIntervalMs` | 否 | reflection 心跳间隔 |
| `maintenance.reflectionBatchSize` | 否 | 每次处理多少条 reflection sample |
| `maintenance.dailyMemoryEnabled` | 否 | 是否自动沉淀 daily memory |
| `maintenance.dailyMemoryIntervalMs` | 否 | daily memory 心跳间隔 |
| `maintenance.dailyMemoryBatchSize` | 否 | 每次处理多少个群的增量 |

### 管理与安全

| 参数 | 是否必需 | 说明 |
| --- | --- | --- |
| `whitelistUserIds` | 否 | 私聊白名单；空数组表示所有人可私聊 |
| `admins` | 强烈建议 | 管理员 QQ 列表，用于审批和控制面 |
| `disableCommandsForAgents` | 强烈建议 | 在 QQ 会话中对指定 agent 禁用 `/status`、`!bash` 等命令式输入 |

## 如何使用

### 群聊即时回复

- 在任意群里 `@` 机器人
- 插件会把这一轮正式路由给 `persona-core`
- 如果 `persona-core` 决定回复，再交给 `voice-organ`

### 白名单群自动巡检

- 把群号放进 `monitorGroups`
- 插件会在“时间到”或“消息数达到阈值”时做 periodic patrol
- 如果人格体判断值得参与，再正式发言

### 管理员控制面

管理员私聊支持：

- `/approve ...`
  处理 OpenClaw `exec` 审批
- `/reflect [groupId] [limit]`
  手动触发 reflection

### 审批后的异步补结果

- 当 `persona-core` 触发需要审批的工具动作时，群里先收到一条等待提示
- 审批完成后，插件会把 followup 结果收进持久化 job
- 发送前会尽量重新走 persona / voice finalize
- 同一份 followup 结果会做去重，避免重复发群

## 风险、安全边界与推荐策略

### 1. 网络与 QQ 账号风险

风险：

- NapCat WebSocket 一旦裸露到公网，等同于把 QQ 机器人入口直接暴露出去
- `accessToken` 泄露后，攻击者可能伪造或读取频道流量

策略：

- 默认只监听 `127.0.0.1`
- 必须设置 `accessToken`
- 跨机部署时只走受控内网、VPN、Tailscale 或零信任代理

### 2. 群聊隐私与本地落盘风险

风险：

- 插件会把群消息、图片摘要、reflection sample、followup job 写到本地 sqlite
- 这意味着你要对磁盘、备份、日志和导出文件负责

策略：

- 只监控你明确同意纳入系统的群
- 对运行机器做磁盘加密和账户隔离
- 谨慎备份 `group_chat.sqlite`、workspace 和记忆文件

### 3. 工具执行风险

风险：

- `persona-core` 可以拥有 `exec`
- 如果审批边界太宽，模型有可能把高风险操作推到管理员确认链路上

策略：

- 只给 `persona-core` 打开真正需要的工具
- `exec` 必须走 OpenClaw 原生审批
- 管理员目标必须是你自己可控的私聊 QQ
- 审批前先看清命令和意图，不要机械同意

### 4. 人格与表达边界

风险：

- 如果让 `voice-organ` 拥有工具、读写或系统访问权限，它就不再只是表达器官
- 如果把所有群聊碎片无差别提升为长期记忆，人格会很快漂移

策略：

- `voice-organ` 保持无工具、无读写的窄权限
- 长期记忆留给 `persona-core` 在 reflection / daily memory 中慢慢吸收
- 不要让单次对话直接重写 `SOUL.md`

### 5. QQ 侧命令注入风险

风险：

- 用户在 QQ 里直接发 `/status`、`!bash`、`/model` 之类的字符串，可能污染会话或误触控制语义

策略：

- 把 `persona-core`、`voice-organ` 加进 `disableCommandsForAgents`
- 控制面只走管理员私聊

## 当前实现边界

### 已支持

- 群聊 `@` 触发正式人格回合
- 白名单群 periodic patrol
- 图片摘要与问图上下文
- `persona-core -> voice-organ` 正式主链
- `exec` 审批桥接到管理员私聊
- `/approve` 与 `/reflect` 控制面拦截
- 自动 reflection heartbeat
- daily memory 增量沉淀
- 审批 followup 持久化与去重

### 当前策略说明

- 自动维护目前默认由插件内 heartbeat 驱动
- 如果你已经有成熟的 OpenClaw cron 体系，可以再把维护任务拆到 cron，但 README 这里先按插件原生维护循环说明

## 为什么这个插件值得单独存在

因为它解决的不是“QQ 上能不能发消息”，而是下面这件更难的事：

把 QQ 群聊接到一个持续存在、拥有会话连续性、能接受审批约束、能沉淀真实表达样本、还能逐步形成稳定人格记忆的 OpenClaw runtime 里。

如果你要的只是“QQ 自动回复”，这套东西会显得重。
如果你要的是“独立人格体在 QQ 里长期活着”，这套分层就是必要成本。
