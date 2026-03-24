# OpenClaw NapCat QQ 插件

NapCat（OneBot v11）的 OpenClaw QQ 频道插件。这个仓库现在的主目标，不再是“给 QQ 接一个能自动回话的 agent”，而是把 QQ 群聊接到一个持续存在、可被观察、可被约束、也可逐步自我演化的人格体运行时上。

- GitHub：<https://github.com/saymyzj/openclaw-NapCatQQ>
- English README: [README.en.md](./README.en.md)
- 中文别名页：[README.zh-CN.md](./README.zh-CN.md)
- 贡献说明：[CONTRIBUTING.md](./CONTRIBUTING.md)

## 现在的项目颗粒度

当前实现已经收敛到下面这条主链：

- `persona-core`：唯一正式群聊主脑
- `voice-organ`：表达器官，只负责润色，不新增事实
- NapCat 插件：QQ 世界适配层，负责消息接入、session 路由、审批桥接、控制面拦截、真实消息落地

已经移除的旧兼容方向：

- `chat`
- `chat-brain`
- `chat-surface`
- `planner`
- 插件内的 precheck / dual-brain / 单脑群聊 fallback

也就是说，这个插件现在不再维护“多套群聊脑并存”的兼容逻辑，正式群聊回复主链只有一条：

`NapCat inbound -> persona-core runtime run -> voice-organ -> QQ outbound`

## 这个插件在做什么

它做的不是“帮 OpenClaw 发 QQ 消息”这么简单，而是把 QQ 群聊包装成一个对人格体友好的世界接口：

- 任何群里 `@` 机器人，可以立即触发人格体正式回合
- 白名单群会缓冲最近消息，并按时间或消息条数触发 periodic check
- 插件自己维护 canonical ledger，保存“世界真相”
- 人格连续性由稳定 `sessionKey` 维持
- `exec` 审批通过 NapCat 私聊桥接到管理员
- `/approve`、`/reflect` 属于控制平面，会被前置拦截，不进入普通聊天会话
- QQ 图片、视频、文件都能原生发送
- Markdown、图片 URL、`<qqimg>/<qqvideo>/<qqfile>` 之类输出会被自动整理成 QQ 可发送格式

## 目前最重要的创新点

### 1. runtime-first，而不是聊天接口拼装

`persona-core` 和 `voice-organ` 走的是 OpenClaw runtime agent run，不是把 QQ 消息临时包一层再手写 `/v1/chat/completions` 主链。

这意味着：

- 工具调用会进入真实 agent session
- `exec` 审批可以接上 OpenClaw 原生机制
- 后续的 reflection、memory、followup 才有机会和同一人格连续体对齐

### 2. canonical ledger + agent session 双层记忆

插件侧保存的是“世界真相”：

- 谁说了什么
- 图片/媒体是什么
- 最终实际发出去的话是什么
- 群聊 engagement 状态是什么

agent session 保存的是“人格内部连续性”：

- 最近几轮自己怎么理解世界
- 自己的工具调用历史
- 自己的表达惯性

这两层不会互相替代。

### 3. 人格进化被当成正式系统目标，而不是 prompt 装饰

当前已经具备的基础：

- 每次正式群聊回复后，会把 `persona_draft -> voice_final` 样本写入 reflection sample
- `/reflect` 可以手动触发 `persona-core` 的 reflection 模式
- 审批、失败、异步补结果这些边界情况，都会影响人格体真实看到的历史和未来可吸收的表达样本

接下来要做的，不是再叠更多“聊天模板”，而是让人格体能在控制边界内逐步更新自己的长期记忆与表达习惯。

## 当前行为边界

### 已支持

- 群聊 `@` 触发人格体即时回复
- 白名单群 periodic check
- 群聊图片理解与图片摘要注入
- `voice-organ` 默认改写，不再只是复读 `persona-core`
- `exec` 审批通过 NapCat 私聊发给管理员
- `/approve` 与 `/reflect` 控制面拦截
- 审批等待时，不会再提前输出一版假的最终答案
- 审批完成后的异步结果会尽量补走一次 `voice-organ`

### 还没有完成

- 自动 reflection 调度
- 当日聊天记录自动沉淀到 persona memory
- 更稳的 async followup 统一回到 `persona -> voice` 主链

## 安装

```bash
git clone https://github.com/saymyzj/openclaw-NapCatQQ ~/.openclaw/extensions/napcat-qq
cd ~/.openclaw/extensions/napcat-qq
npm install
npm run build
```

然后在 `openclaw.json` 中启用插件，并重启 OpenClaw gateway。

## 推荐的 OpenClaw 配置形态

现在推荐的本地布局只保留三类主体：

- `main`
  用于可信私聊、控制面、人工维护
- `persona-core`
  用于正式群聊人格回合与 reflection
- `voice-organ`
  用于群聊表达润色

一个简化后的示意配置：

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
          "allow": ["read", "write", "edit", "apply_patch", "exec", "web_fetch", "memory_search", "memory_get"],
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
      "monitorGroups": [123456789],
      "autoIntervene": true,
      "autoCheckIntervalMs": 30000,
      "autoCheckMessageThreshold": 10,
      "whitelistUserIds": ["1234567890"],
      "admins": ["1234567890"],
      "historyLimit": 100,
      "rateLimitMs": 1000,
      "renderMarkdownToPlain": true,
      "multimodalImagesEnabled": true,
      "multimodalImageMaxCount": 3,
      "persona": {
        "enabled": true,
        "coreAgentId": "persona-core",
        "voiceAgentId": "voice-organ",
        "voiceOnGroupOnly": true
      },
      "disableCommandsForAgents": ["persona-core", "voice-organ"]
    }
  }
}
```

## 人格进化相关说明

这个插件里，“人格进化”现在不是抽象概念，而是一个明确的工程分层：

- 聊天正式回合：
  `persona-core` 决定要不要说、说什么核心意思
- 表达器官：
  `voice-organ` 把核心意思改写成更自然的群友语气
- 样本沉淀：
  插件把 `persona_draft / voice_final / context_excerpt` 写成 reflection sample
- 手动反思：
  管理员私聊 `/reflect`
- 下一步：
  heartbeat / cron 自动消费 pending reflection samples
- 再下一步：
  保存当日聊天记录，沉淀 daily memory，再由 reflection 决定哪些内容上升为长期记忆

## 为什么不再保留旧兼容链路

因为“多套脑并行 + 旧 fallback 长期共存”会带来三个问题：

- 人格体并不真的拥有会话连续性
- 审批、工具、私聊回传会变得不可靠
- 后续做 reflection 和 memory 时，历史会混进不属于人格体自己的输出

所以这个仓库现在明确选择：

- 删掉旧群聊兼容链路
- 只维护 persona 主链
- 把精力留给自动 reflection、daily memory、async followup 收敛

## 参考与感谢

这个仓库直接受益于以下项目与规范：

- [openclaw/openclaw](https://github.com/openclaw/openclaw)
  感谢 OpenClaw 提供 agent runtime、tooling、session、approval 与插件运行时。
- [NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ)
  感谢 NapCat 提供 QQ 到 OneBot v11 的稳定桥接能力。
- [botuniverse/onebot-v11](https://github.com/botuniverse/onebot-v11)
  感谢 OneBot v11 规范提供统一的动作/事件模型，让 QQ 适配层可以更清晰地工程化。

如果没有这些上游工作，这个插件不会长成现在这个样子。谢谢。

## 接下来的任务

- 自动 reflection：从手动 `/reflect` 走向 heartbeat + cron 调度
- daily memory：存储当日聊天记录，供人格体进行日级回顾
- async followup 收敛：让审批后、异步查完后的结果也稳定回到 `persona -> voice` 主链
- 更稳定的 persona 文件维护边界：避免 reflection 修改超出人格工作区的内容

## 许可证

MIT
