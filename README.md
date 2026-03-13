# OpenClaw NapCat Plugin

NapCat (OneBot v11) 频道插件，将 QQ 群聊接入 OpenClaw AI 助手。

核心能力：**任何群 @机器人 即时回复 + 白名单群定期巡检自动参与**。AI 会自动识别回复中的图片 URL 并以 QQ 原生图片发送，Markdown 标记也会自动转为纯文本。

## 功能一览

| 功能 | 说明 |
|------|------|
| @即时回复 | 任何群聊中 @机器人，立即回复（附最近 10 条上下文） |
| 白名单群巡检 | `monitorGroups` 中的群每 30s 或每 10 条消息自动收集，发给 AI 判断是否参与 |
| 私聊 | 直接对话 AI，可通过 `whitelistUserIds` 限制可用用户 |
| 多媒体发送 | 文本、图片、视频、文件，群聊与私聊均支持 |
| 图片自动提取 | AI 回复中的 `![](url)` 和裸图片 URL 自动提取为 QQ 原生图片发送 |
| Markdown 转纯文本 | 自动去除 AI 回复中的标题、加粗、列表等标记，适配 QQ 显示 |
| 断线重连 | WebSocket 断开后指数退避自动重连（1s → 2s → 5s → 10s → 30s → 60s） |
| 思考表情 | 收到 @消息 后添加"思考中"表情，回复完成后自动取消 |
| 详细日志 | 记录每条收发消息的完整内容和消息段，方便排查 |

## 前置条件

- [OpenClaw](https://github.com/openclaw/openclaw) 2026.1.0+
- [NapCat](https://github.com/NapNeko/NapCatQQ) 已部署并完成 QQ 登录
- NapCat 已配置 OneBot v11 **正向 WebSocket**
- Node.js 22+

## 安装

```bash
# 克隆到 OpenClaw 扩展目录
git clone <本仓库地址> ~/.openclaw/extensions/napcat-qq
cd ~/.openclaw/extensions/napcat-qq
npm install
npm run build
```

安装完成后重启 OpenClaw Gateway 即可加载插件。

## 配置

在 OpenClaw 配置文件（`~/.openclaw/config.json` 或 `openclaw.json`）中添加：

```json5
{
  channels: {
    napcat: {
      // ─── 连接 ───
      host: "127.0.0.1",                // NapCat WebSocket 地址
      port: 3001,                       // NapCat 正向 WebSocket 端口
      accessToken: "",                  // access token（如有）
      path: "/",                        // WebSocket 路径

      // ─── 群聊监控 ───
      monitorGroups: [123456, 789012],  // 白名单群号，这些群会定期巡检
                                        // 空数组 = 不主动监控，仅响应 @
      autoIntervene: true,              // 是否启用白名单群的定期巡检
      autoCheckIntervalMs: 30000,       // 巡检间隔（毫秒），默认 30 秒
      autoCheckMessageThreshold: 10,    // 消息累积阈值，达到即触发巡检
      autoIntervenePrompt: "",          // 巡检时附加给 AI 的额外指引（可选）

      // ─── 权限 ───
      whitelistUserIds: [],             // 私聊白名单 QQ 号，空 = 所有人可私聊
      admins: [],                       // 管理员 QQ 号

      // ─── 行为 ───
      historyLimit: 20,                 // 会话历史保留条数
      rateLimitMs: 1000,                // 发送间隔（毫秒）
      renderMarkdownToPlain: true       // AI 回复转纯文本后发送
    }
  }
}
```

### 配置项速查

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `host` | string | `127.0.0.1` | NapCat WebSocket 主机 |
| `port` | number | `3001` | NapCat WebSocket 端口 |
| `accessToken` | string | — | NapCat access token |
| `path` | string | `/` | WebSocket 路径 |
| `monitorGroups` | number[] | `[]` | 白名单群号列表，空 = 不主动监控 |
| `autoIntervene` | boolean | `true` | 是否启用白名单群定期巡检 |
| `autoCheckIntervalMs` | number | `30000` | 巡检时间间隔（ms） |
| `autoCheckMessageThreshold` | number | `10` | 消息累积数量阈值 |
| `autoIntervenePrompt` | string | — | 巡检时附加给 AI 的提示词 |
| `whitelistUserIds` | number[] | `[]` | 私聊白名单，空 = 所有人 |
| `admins` | number[] | `[]` | 管理员 QQ 号 |
| `historyLimit` | number | `20` | 会话历史保留条数 |
| `rateLimitMs` | number | `1000` | 消息发送间隔（ms） |
| `renderMarkdownToPlain` | boolean | `true` | Markdown → 纯文本 |

### 环境变量（可选）

不写配置文件时，可用环境变量设置基础连接：

```bash
export NAPCAT_WS_HOST=127.0.0.1
export NAPCAT_WS_PORT=3001
export NAPCAT_WS_ACCESS_TOKEN=your_token
```

> 环境变量仅支持连接参数，群聊监控等功能需要配置文件。

## NapCat 侧配置

在 NapCat WebUI 中配置 OneBot v11 网络：

1. 打开 `http://<服务器IP>:6099/webui`，使用 token 登录
2. 进入「网络配置」
3. 添加一个**正向 WebSocket** 服务：
   - 监听地址：`0.0.0.0`
   - 端口：`3001`
   - 消息格式：`array`（推荐）
4. 保存并重启 NapCat

## Docker 部署示例

```yaml
version: "3"
services:
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    ports:
      - 3000:3000   # HTTP API
      - 3001:3001   # WebSocket
      - 6099:6099   # WebUI
    restart: always
    network_mode: bridge
```

## 消息处理流程

### 群聊

```
收到群消息
    │
    ├─ 有人 @机器人？
    │    └─ 是 → 立即回复（任何群都生效，附最近 10 条上下文）
    │
    ├─ 群在 monitorGroups 白名单中？
    │    ├─ 否 → 静默，不处理
    │    └─ 是 → 缓存消息，检查是否触发巡检：
    │              ├─ 距上次巡检 ≥ 30s 且有 ≥ 2 条新消息 → 触发
    │              ├─ 新消息累积 ≥ 10 条 → 触发
    │              └─ 未达到 → 继续缓存，等待下次
    │
    └─ 巡检触发时：
         收集最近 15 条消息 → 发给 AI 询问
         → AI 判断需要回复 → 发送回复到群
         → AI 判断不需要 → 回复 NO_REPLY → 静默跳过
```

### 私聊

```
收到私聊消息
    │
    ├─ whitelistUserIds 非空？
    │    ├─ 用户在白名单中 → 处理
    │    └─ 用户不在白名单中 → 忽略
    │
    └─ whitelistUserIds 为空 → 所有用户都处理
```

### 图片处理

AI 回复中的图片会自动提取并以 QQ 原生图片消息发送，支持两种格式：

- Markdown 图片：`![描述](https://example.com/image.png)`
- 裸图片 URL：`https://example.com/photo.jpg`

支持的图片格式：`.png` `.jpg` `.jpeg` `.gif` `.webp` `.bmp`

提取后，URL 从文本中移除，文本部分作为普通消息发送，图片部分作为 OneBot image 消息段发送。

## 发送消息

### 命令行

```bash
# 发送文本到群聊
openclaw message send --channel napcat --to group:123456 "Hello World"

# 发送文本到私聊
openclaw message send --channel napcat --to user:654321 "你好"

# 发送图片到群聊
openclaw message send --channel napcat --to group:123456 --media /path/to/image.png "看这张图"

# QQ 号大于 1 亿时自动识别为私聊
openclaw message send --channel napcat --to 1234567890 "直接用 QQ 号"
```

### 目标格式

| 格式 | 说明 |
|------|------|
| `group:123456` | 群聊，群号 123456 |
| `user:654321` | 私聊，QQ 号 654321 |
| `654321` | 自动判断：> 1 亿为私聊，否则为群聊 |

## 日志

插件会输出详细日志，所有日志以 `[napcat]` 为前缀。

### 日志内容

| 标记 | 含义 |
|------|------|
| `◀ recv` | 收到消息 — 包含类型、发送者、群号、消息原文、消息段详情 |
| `skip group msg` | 群消息被跳过（原因：未@、不在白名单群、未达到巡检条件） |
| `@mentioned` | 检测到 @机器人，开始处理 |
| `periodic check triggered` | 白名单群巡检条件满足，开始巡检 |
| `▶ dispatching to AI` | 消息正在发送给 AI 处理 |
| `▶ AI reply` | AI 回复内容（含 mediaUrl 信息） |
| `▶ AI replied NO_REPLY` | AI 判断不需要回复，静默跳过 |
| `deliver failed` | 消息发送到 QQ 失败 |

### 查看日志

取决于 OpenClaw 的运行方式：

```bash
# 前台运行 — 日志直接输出到终端

# systemd
journalctl -u openclaw -f | grep '\[napcat\]'

# PM2
pm2 logs openclaw | grep '\[napcat\]'

# Docker
docker logs -f <container> 2>&1 | grep '\[napcat\]'
```

## 项目结构

```
napcat-qq/
├── src/
│   ├── index.ts                    # 入口，注册插件
│   ├── channel.ts                  # Channel 插件定义（outbound 接口）
│   ├── service.ts                  # WebSocket 服务（连接、重连、消息分发）
│   ├── connection.ts               # OneBot v11 API 封装（发送/接收/媒体处理）
│   ├── send.ts                     # 高级发送接口（文本/图片/视频/文件）
│   ├── config.ts                   # 配置解析
│   ├── types.ts                    # TypeScript 类型定义
│   ├── message.ts                  # 消息解析工具（文本提取、@检测、图片URL提取）
│   ├── markdown.ts                 # Markdown → 纯文本转换
│   ├── sdk.ts                      # OpenClaw Plugin SDK 懒加载
│   ├── reply-context.ts            # 回复目标上下文管理
│   └── handlers/
│       ├── process-inbound.ts      # 入站消息处理（@回复、定期巡检、私聊分发）
│       └── auto-intervene.ts       # 群聊巡检引擎（消息缓冲、周期判断、并发锁）
├── skills/
│   └── napcat-ops/
│       └── SKILL.md                # 消息操作 Skill 说明
├── openclaw.plugin.json            # 插件清单与配置 Schema
├── package.json
└── tsconfig.json
```

## 开发

```bash
# 监听模式编译
npm run dev

# 一次性编译
npm run build
```

修改代码后重启 OpenClaw Gateway 即可生效。

## 许可

MIT
