# OpenClaw NapCat Plugin

NapCat (OneBot v11) 频道插件，将 QQ 群聊接入 OpenClaw AI 助手。

支持消息收发、多媒体传输，以及**群聊智能监控与自动介入**——AI 会根据群聊内容自动判断是否需要回复，无需每次 @机器人。

## 功能

- **消息收发** — 文本、图片、视频、文件，群聊与私聊均支持
- **群聊监控** — 实时接收并缓存群消息，为 AI 提供对话上下文
- **自动介入** — 检测求助、提问、报错等场景，AI 自主判断是否回复
- **关键词触发** — 可配置关键词列表，命中即触发 AI 回复
- **白名单控制** — 限制可触发 AI 的用户
- **Markdown 转纯文本** — 自动将 AI 回复中的 Markdown 标记去除，适配 QQ 显示
- **断线重连** — WebSocket 断开后自动指数退避重连
- **思考表情** — 收到消息后添加"思考"表情，回复完成后取消

## 前置条件

- [OpenClaw](https://github.com/openclaw/openclaw) 2026.1.0+
- [NapCat](https://github.com/NapNeko/NapCatQQ) 已部署并完成 QQ 登录
- NapCat 已配置 OneBot v11 **正向 WebSocket**
- Node.js 22+

## 安装

### 方式一：本地链接（开发推荐）

```bash
git clone <本仓库地址> ~/.openclaw/extensions/napcat-qq
cd ~/.openclaw/extensions/napcat-qq
npm install
npm run build
```

### 方式二：手动复制

将整个 `napcat-qq` 目录放入 `~/.openclaw/extensions/`，然后执行：

```bash
cd ~/.openclaw/extensions/napcat-qq
npm install && npm run build
```

安装完成后重启 OpenClaw Gateway 即可加载插件。

## 配置

在 OpenClaw 配置文件（`~/.openclaw/config.json` 或 `openclaw.json`）中添加：

```json5
{
  channels: {
    napcat: {
      host: "127.0.0.1",       // NapCat WebSocket 地址
      port: 3001,              // NapCat 正向 WebSocket 端口
      accessToken: "",         // access token（如有）
      path: "/",               // WebSocket 路径

      // ─── 群聊监控 ───
      monitorGroups: [],       // 监控的群号列表，空数组 = 监控所有群
      autoIntervene: true,     // 启用自动介入
      requireMention: false,   // false = 不需要 @机器人也能触发自动介入

      // ─── 触发规则 ───
      autoInterveneKeywords: [ // 关键词列表，命中任一即触发回复
        "帮忙",
        "怎么办",
        "求助"
      ],

      // ─── 权限 ───
      whitelistUserIds: [],    // 白名单 QQ 号，空 = 所有人可触发
      admins: [],              // 管理员 QQ 号

      // ─── 行为 ───
      historyLimit: 20,        // 会话历史保留条数
      rateLimitMs: 1000,       // 发送间隔（毫秒）
      renderMarkdownToPlain: true  // AI 回复转纯文本
    }
  }
}
```

### 环境变量（可选）

如果不想写配置文件，也可以通过环境变量设置基础连接参数：

```bash
export NAPCAT_WS_HOST=127.0.0.1
export NAPCAT_WS_PORT=3001
export NAPCAT_WS_ACCESS_TOKEN=your_token
```

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

## 使用

### 发送消息

```bash
# 发送文本到群聊
openclaw message send --channel napcat --to group:123456 "Hello World"

# 发送文本到私聊
openclaw message send --channel napcat --to user:654321 "你好"

# 发送图片
openclaw message send --channel napcat --to group:123456 --media /path/to/image.png "看这张图"

# QQ 号大于 1 亿时自动识别为私聊
openclaw message send --channel napcat --to 1234567890 "直接用 QQ 号"
```

### 目标格式

| 格式 | 说明 |
|------|------|
| `group:123456` | 群聊，群号 123456 |
| `user:654321` | 私聊，QQ 号 654321 |
| `654321` | 自动判断：>1亿 为私聊，否则为群聊 |

## 自动介入机制

插件会监控所有（或指定）群的消息，按以下优先级判断是否让 AI 介入：

```
1. @机器人        → 必定回复
2. 关键词命中      → 回复（可配置 autoInterveneKeywords）
3. 智能模式匹配    → 检测求助/提问/报错等场景，回复
4. 以上均未命中    → 静默，不回复
```

### 智能匹配的场景

- 求助类：「怎么办」「如何」「请问」「有人知道吗」「帮帮忙」
- 错误类：「报错」「出bug了」「error」「failed」「crash」
- 问题类：「为什么」「什么原因」「能不能」「可以吗」
- 英文类：「how to」「help」「can't」「doesn't work」

当 AI 判断该消息不需要回复时，会返回 `NO_REPLY`，插件将静默跳过。

### 上下文感知

自动介入时，AI 不仅能看到当前消息，还会收到最近 10 条群聊记录作为上下文，从而做出更准确的判断。

## 项目结构

```
napcat-qq/
├── src/
│   ├── index.ts              # 入口，注册插件
│   ├── channel.ts            # Channel 插件定义（outbound 接口）
│   ├── service.ts            # WebSocket 服务（连接、重连、消息分发）
│   ├── connection.ts         # OneBot v11 API 封装（发送/接收）
│   ├── send.ts               # 高级发送接口（文本/图片/视频/文件）
│   ├── config.ts             # 配置解析
│   ├── types.ts              # TypeScript 类型定义
│   ├── message.ts            # 消息解析工具
│   ├── markdown.ts           # Markdown → 纯文本
│   ├── sdk.ts                # OpenClaw Plugin SDK 加载
│   ├── reply-context.ts      # 回复上下文管理
│   └── handlers/
│       ├── process-inbound.ts    # 入站消息处理与 AI 分发
│       └── auto-intervene.ts     # 自动介入判断引擎
├── skills/
│   └── napcat-ops/
│       └── SKILL.md          # 消息操作 Skill 说明
├── openclaw.plugin.json      # 插件清单
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
