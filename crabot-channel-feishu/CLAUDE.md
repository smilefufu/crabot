# crabot-channel-feishu

飞书 / Lark Channel 模块。基于 `@larksuiteoapi/node-sdk` 的长连接事件订阅，无需公网回调。

## 架构

```
飞书消息
  → open.feishu.cn (lark.WSClient 长连接)
  → ws-subscriber.ts 分发到 lark.EventDispatcher 注册的 handler
  → event-mapper.ts 转换为 ChannelMessage
  → 发布 channel.message_received 事件到 Module Manager
  → Agent 处理
  → Agent 调用 send_message RPC
  → feishu-client.ts → lark.Client → open.feishu.cn REST API
```

扫码 onboarding 由 `crabot-admin` 独立提供（`feishu-onboard.ts` 设备码 OAuth），channel 模块本身只关心"已经有 app_id/app_secret 时如何工作"。

## 与 channel-host 的区别

- **channel-host** 是 OpenClaw 插件兼容层（Shim），加载 `@openclaw/feishu` 等插件运行
- **channel-feishu** 直接使用 lark SDK，不依赖 OpenClaw 生态，运行时占用更小

## 环境变量

| 变量 | 必须 | 说明 |
|------|------|------|
| `Crabot_MODULE_ID` | 是 | 模块实例 ID |
| `Crabot_PORT` | 是 | RPC 监听端口 |
| `DATA_DIR` | 否 | 数据目录（默认 ./data） |
| `FEISHU_APP_ID` | 是 | 飞书应用 App ID（`cli_` 前缀） |
| `FEISHU_APP_SECRET` | 是 | 飞书应用 App Secret |
| `FEISHU_DOMAIN` | 否 | `feishu`（默认）或 `lark`（国际版） |
| `FEISHU_OWNER_OPEN_ID` | 否 | 扫码时绑定的飞书账号 open_id |
| `FEISHU_ONLY_RESPOND_TO_MENTIONS` | 否 | 群聊是否仅响应 @ Crabot（默认 `true`） |
| `FEISHU_MARKDOWN_FORMAT` | 否 | `auto`（默认）/ `on` / `off`：发文本时是否按 Markdown 渲染。启用时改用 `interactive` 卡片 + `markdown` 元素，飞书才会渲染样式 |

## 消息类型支持

| 飞书 msg_type | Crabot 映射 | 处理 |
|---|---|---|
| text | text | 替换 `@_user_*` 占位符为可读名 |
| post | text | 拍平 rich text |
| image | image | 用 `im.message.resource.get` 下载到 `data_dir/media/` |
| file | file | 同上 |
| audio / video / sticker / location / share_* / merge_forward | text | 降级为占位文本 |

## 构建和运行

```bash
corepack pnpm install
corepack pnpm run build
corepack pnpm start
```

## 测试

```bash
corepack pnpm test
```

## 依赖

- `@larksuiteoapi/node-sdk` ^1.46.0 — 飞书官方 Node SDK（lark.Client + lark.WSClient + lark.EventDispatcher）
- `crabot-shared` — 模块基类、RPC 客户端、代理管理

## 文件结构

```
src/
├── main.ts              ← 入口：读环境变量，创建 FeishuChannel 实例
├── feishu-channel.ts    ← 主类：实现 Crabot Channel 协议 + 注册 RPC + 生命周期
├── feishu-client.ts     ← 包装 lark.Client：发消息、查 chat/user、上传/下载文件
├── ws-subscriber.ts     ← 包装 lark.WSClient：事件分发 + 重连状态管理
├── event-mapper.ts      ← 飞书事件 → Crabot ChannelMessage / Session
├── session-manager.ts   ← Session 持久化（chat_id → Crabot Session）
├── message-store.ts     ← 历史消息 JSONL 存储 + 周期清理
└── types.ts             ← 飞书事件类型 + Crabot 协议子集
```
