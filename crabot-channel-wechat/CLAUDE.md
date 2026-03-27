# crabot-channel-wechat

微信 Channel 模块，通过 wechat-connector 的 Bot API 接入微信。

## 架构

```
微信消息
  → wechat-connector（MQTT 接收 → 构建 WechatRawEvent）
  → Socket.IO / Webhook 推送到 crabot-channel-wechat
  → 转换为 ChannelMessage
  → 发布 channel.message_received 事件到 Module Manager
  → Agent 处理
  → Agent 调用 send_message RPC
  → crabot-channel-wechat 调用 REST API POST /api/v1/bot/send
  → wechat-connector 下发 MQTT 任务到 Puppet
  → Puppet 发送微信消息
```

## 与 channel-host 的区别

- **channel-host** 是 OpenClaw 插件兼容层（Shim），加载 OpenClaw 插件运行
- **channel-wechat** 直接对接 wechat-connector 的 Bot REST API，不依赖 OpenClaw 生态

## 环境变量

| 变量 | 必须 | 说明 |
|------|------|------|
| `Crabot_MODULE_ID` | 是 | 模块实例 ID |
| `Crabot_PORT` | 是 | RPC 监听端口 |
| `DATA_DIR` | 否 | 数据目录（默认 ./data） |
| `WECHAT_CONNECTOR_URL` | 是 | wechat-connector 服务器地址 |
| `WECHAT_API_KEY` | 是 | Bot API Key（wct_ 前缀） |
| `WECHAT_MODE` | 否 | socketio（默认）或 webhook |
| `WECHAT_WEBHOOK_SECRET` | webhook 模式 | Webhook 签名密钥 |
| `WECHAT_WEBHOOK_PORT` | webhook 模式 | Webhook 监听端口 |

## 构建和运行

```bash
npm install
npm run build
npm start
```

## 文件结构

```
src/
├── main.ts              ← 入口：读环境变量，创建 WechatChannel 实例
├── wechat-channel.ts    ← 主类：实现 Crabot Channel 协议 + 收发消息
├── wechat-client.ts     ← REST API 客户端（发消息、查联系人等）
├── session-manager.ts   ← Session 管理（微信会话 → Crabot Session 映射）
├── message-store.ts     ← 消息历史存储（JSONL 格式）
├── types.ts             ← 类型定义（WechatRawEvent + Crabot Channel 协议）
└── core/                ← 模块基类（复制自 channel-host）
```
