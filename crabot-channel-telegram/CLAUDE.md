# crabot-channel-telegram

Telegram Channel 模块，通过 Telegram Bot API 接入 Telegram。

## 架构

```
Telegram 消息
  → Bot API (getUpdates long polling 或 Webhook)
  → crabot-channel-telegram 接收 TgUpdate
  → 转换为 ChannelMessage
  → 发布 channel.message_received 事件到 Module Manager
  → Agent 处理
  → Agent 调用 send_message RPC
  → crabot-channel-telegram 调用 Bot API sendMessage/sendPhoto/sendDocument
  → Telegram 发送消息
```

## 与 channel-host 的区别

- **channel-host** 是 OpenClaw 插件兼容层（Shim），加载 OpenClaw 插件运行
- **channel-telegram** 直接对接 Telegram Bot API，不依赖 OpenClaw 生态

## 环境变量

| 变量 | 必须 | 说明 |
|------|------|------|
| `Crabot_MODULE_ID` | 是 | 模块实例 ID |
| `Crabot_PORT` | 是 | RPC 监听端口 |
| `DATA_DIR` | 否 | 数据目录（默认 ./data） |
| `TELEGRAM_BOT_TOKEN` | 是 | 从 @BotFather 获取的 Bot Token |
| `TELEGRAM_MODE` | 否 | polling（默认）或 webhook |
| `TELEGRAM_WEBHOOK_URL` | webhook 模式 | 公网回调 URL |
| `TELEGRAM_WEBHOOK_SECRET` | 否 | Webhook 签名密钥 |
| `TELEGRAM_MARKDOWN_FORMAT` | 否 | `auto`（默认）/ `on` / `off`：发文本时是否按 Markdown 渲染。auto 仅在检测到 markdown 标记时启用，启用后转 HTML 用 `parse_mode=HTML` 发送 |

## 消息类型支持

| Telegram 类型 | Crabot 映射 |
|------|------|
| text | text |
| photo | image（下载到本地） |
| document | file（下载到本地） |
| voice/video/sticker/audio/location | text（降级） |

## 构建和运行

```bash
npm install
npm run build
npm start
```

## 依赖

- `crabot-shared` — 模块基类、RPC 客户端、代理管理

## 文件结构

```
src/
├── main.ts              ← 入口：读环境变量，创建 TelegramChannel 实例
├── telegram-channel.ts  ← 主类：Channel 协议 + 收发消息 + polling/webhook
├── telegram-client.ts   ← Telegram Bot API HTTP 封装（fetch）
├── session-manager.ts   ← Session 管理（chat_id → Crabot Session 映射）
├── message-store.ts     ← 消息历史存储（JSONL + 定期清理）
└── types.ts             ← 类型定义（Telegram API + Crabot Channel 协议）
```
