# crabot-channel-dingtalk

钉钉（DingTalk）Channel 模块。基于官方 `dingtalk-stream-sdk-nodejs` 的 **Stream 模式**长连接，无需公网回调地址（对标 feishu 的长连接接入）。

## 架构

```
钉钉消息
  → open.dingtalk.com (DWClient Stream 长连接)
  → stream-subscriber.ts 分发到 registerCallbackListener('/v1.0/im/bot/messages/get')
  → event-mapper.ts 转换为 ChannelMessage
  → 发布 channel.message_received / channel.session_changed 事件到 Module Manager
  → Agent 处理
  → Agent 调用 send_message RPC
  → dingtalk-client.ts（access_token 缓存 → robot/groupMessages/send 或 robot/oToMessages/batchSend；
     sessionWebhook 兜底）→ open.dingtalk.com REST API
```

配置由用户在 Admin「手动填写」表单录入 AppKey/AppSecret/robotCode（`crabot-module.yaml` 的 `config_schema` 通用渲染）；channel 主体只关心「已有 AppKey/AppSecret/robotCode 时如何工作」。引导式 onboarding + auto-master 绑定为**后续项**（v1 不声明 `onboarding_methods`，详见「已知取舍」）。

## 环境变量

| 变量 | 必须 | 说明 |
|------|------|------|
| `Crabot_MODULE_ID` | 是 | 模块实例 ID |
| `Crabot_PORT` | 是 | RPC 监听端口 |
| `DATA_DIR` | 否 | 数据目录（默认 ./data） |
| `DINGTALK_APP_KEY` | 是 | 企业内部应用 AppKey（= Stream clientId） |
| `DINGTALK_APP_SECRET` | 是 | 企业内部应用 AppSecret（= Stream clientSecret） |
| `DINGTALK_ROBOT_CODE` | 是 | 机器人 robotCode（出站发送必需） |
| `DINGTALK_OWNER_STAFF_ID` | 否 | 主人 staffId（跨渠道复用主人身份） |
| `DINGTALK_ONLY_RESPOND_TO_MENTIONS` | 否 | 群聊是否仅响应 @ Crabot（默认 `true`） |
| `DINGTALK_MARKDOWN_FORMAT` | 否 | `auto`（默认）/ `on` / `off`：发文本时是否按 Markdown 渲染（启用时用 `sampleMarkdown`） |

## 消息类型支持

| 钉钉 msgtype | Crabot 映射 | 处理 |
|---|---|---|
| text | text | 原样 |
| markdown | text | title + 正文拍平 |
| richText | image / text | **真机实测**：群里发图 + @ 走这条。含图片元素 → image（取 `content.richText[].downloadCode`）；纯文本 → 拍平为 text |
| picture | image | 凭 `content.downloadCode` 下载（单聊纯图可能走这条） |
| file | file | 惰性 media handle（`status=not_fetched`），`fetch_media` 按需拉取 |
| audio / video / 其它 | text | 降级为占位文本 |

出站 v1 仅支持文本 + Markdown（`get_capabilities.supported_message_types = ['text']`）；出站图片/文件为**非目标**（见设计 §2）。

## 构建和运行

```bash
corepack pnpm install
corepack pnpm run build
corepack pnpm start
```

## 测试

```bash
corepack pnpm test    # vitest；纯逻辑（event-mapper / dingtalk-client / text-splitter）+ 数据层，共 58 用例
```

## 依赖

- `dingtalk-stream-sdk-nodejs` ^2.0.4 — 钉钉官方 Stream SDK（DWClient 长连接）。出站 REST 用原生 `fetch`，无第三方封装。
- `crabot-shared` — 模块基类、RPC 客户端、代理管理、媒体惰性下载（MediaHandleStore/MediaFetchManager）。

## 文件结构

```
src/
├── main.ts              ← 入口：读环境变量，创建 DingtalkChannel 实例
├── dingtalk-channel.ts  ← 主类：实现 Crabot Channel 协议 + 注册 RPC + 生命周期 + 收发
├── dingtalk-client.ts   ← 出站 REST（fetch）：access_token 缓存/刷新 + group/oTo 发送 + 媒体下载
├── stream-subscriber.ts ← 包装 DWClient：Stream 长连接 + 回调分发 + 状态/重连计数
├── event-mapper.ts      ← 钉钉消息 → Crabot MessageContent / features（纯函数）
├── session-manager.ts   ← Session 持久化（conversationId/staffId → Crabot Session）
├── message-store.ts     ← 历史消息 JSONL 存储 + 周期清理
├── text-splitter.ts     ← 超长文本按语义边界切分
└── types.ts             ← 钉钉事件类型 + Crabot 协议子集 + DingtalkChannelConfig
```

## 已知取舍 / 后续项

- **配置方式（v1 = 手动填写）**：钉钉无 OAuth/扫码，凭据（AppKey/Secret/robotCode）由用户在 Admin「手动填写」表单录入（config_schema 字段可编辑、非 readOnly）。**v1 不声明 `onboarding_methods`**——通用 onboarding 向导当前只采集实例名、不透传表单式 `finish` 参数，无法把凭据交给引导式 `finish`。
- **引导式 onboarding + auto-master（后续项，v1 不实现）**：设计稿曾规划「引导建应用 + 校验凭据 + 主人私聊发『绑定』自动认主」。auto-master 是**运行时**行为（onboarding 在模块启动前跑、拿不到发送者 staffId），且引导式 `finish` 依赖向导支持表单式凭据透传——两者 v1 均未实现。`DINGTALK_OWNER_STAFF_ID` 由用户**手动配置**（可选）。待通用向导支持表单式 finish 后再补引导式 onboarding + auto-master。
- **出站媒体**：v1 出站仅 text/markdown，不发图片/文件/卡片（设计 §2 非目标）。
- **出站 @**：v1 出站不注入 @（`supported_features` 留空，不声明 'mention'）；入站 @ 正常解析（`is_mention_crab` / `features.mentions`）。
- **cache 热更**：`update_config` 改 `cache.*` 经 `MessageStore.updateCacheConfig` 即时生效（下次清理循环按新值执行，无需重启），对齐协议 §6.1。
- **list_group_members**：钉钉难枚举全员，返回 `members_complete=false` + `partial_reason`（平台中性语言），`member_count` 尽力而为。
- **平台消息 ID**：token 发送返回 `processQueryKey`（非真实 message_id，类似 wechat），`get_history` 以本地 message-store 为准。
- **Stream SDK 字段（真机已验证 2026-07-04）**：`stream-subscriber` 解析 `DWClientDownStream.data`（JSON）为 `DingtalkInboundMessage`（SDK 只 typed text 子集）。企业应用机器人 spike 实测确认：
  - 群里 @ 机器人时 `isInAtList: true`（@ 检测据此，可靠）；`conversationType: "2"`=群、`conversationId`=群会话 id；私聊 `senderStaffId` 有值。
  - `atUsers` 群聊里**只给 `dingtalkId`（加密串 `$:LWCP_v1:$...`）、不给 `staffId`**；`chatbotUserId` 同为该加密串形态（本条 @ 消息里 `atUsers[0].dingtalkId === chatbotUserId`）。故 `buildMentionsList` 用 `staffId ?? dingtalkId` 兜底、`detectMentionCrab` 主用 `isInAtList` 是对的。
  - `sessionWebhook` 形如 `https://oapi.dingtalk.com/robot/sendBySession?session=...`（旧版 webhook，200+errcode 语义，已在 client 判 errcode）。
  - 出站 `sendGroupMessage(conversationId,...)` 返回 `processQueryKey`，群消息真机送达成功。
  - **图片（群里发图 + @）走 `msgtype:'richText'`、图片在 `content.richText[]`（带 `downloadCode`/`pictureDownloadCode` + `type:'picture'`），不是 `msgtype:'picture'`/`content.downloadCode`**。event-mapper 据此把含图 richText 映射为 image + downloadCode；`getMediaDownloadUrl` 实测换到真实 aliyun OSS downloadUrl。（此为真机测出并修复的 bug。）
```
