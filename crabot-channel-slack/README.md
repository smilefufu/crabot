# Slack Channel

Slack 首版使用官方 Node SDK 的 Socket Mode，不需要公网回调地址。每个实例绑定一个 workspace 的一个 Bot 安装；支持 Bot 与用户的一对一 DM、Bot 已加入的公开/私有 channel。多人 DM（MPIM）不在首版范围。

## 创建 App 与接入

1. 在 [Slack Apps](https://api.slack.com/apps) 创建内部 App，开启 Socket Mode。创建 App-Level Token，授权 `connections:write`，得到 `xapp-…`。
2. 添加 Bot scopes：`chat:write`、`channels:history`、`groups:history`、`channels:read`、`groups:read`、`im:history`、`im:read`、`im:write`、`users:read`；安装到自己的 workspace，取得 `xoxb-…` Bot Token。增改 scopes 后重新安装授权。
3. Event Subscriptions 订阅 Bot events：`message.channels`、`message.groups`、`message.im`。不能仅订阅 `app_mention`，否则关闭 @过滤后也收不到普通群消息；额外订阅它会按 conversation + ts 去重。
4. App Home 开启 Messages Tab 并允许用户向 App 发消息；邀请 Bot 加入目标群，私有群也须邀请。
5. Admin 的 Channel 页选择 Slack，新建实例，填写两种 Token，启动。Master/Friend 身份在 Admin 绑定真实 Slack user ID，Channel 不自动认主。
6. 在 DM 发一条文本，在群 @Bot 发一条文本，确认 Admin 授权、Agent 接纳和 Slack 目标中实际回复。Socket 连接成功或 ACK 只说明平台传输已接收；两个 Token 都有效也不证明属于同一个 App。入站会同时核对 workspace 与 App，Token 配错可能已连接却不能收消息。

官方参考：[Socket Mode](https://docs.slack.dev/tools/node-slack-sdk/socket-mode/)、[Web API](https://docs.slack.dev/tools/node-slack-sdk/web-api/)。本模块实现的是 Crabot 原生 Channel；不使用 Slack MCP 代替消息收发。

## 首版行为

- 私聊人类新消息无需 @，继续由 Admin 按 Friend 规则鉴权。
- 群 `group.only_respond_to_mentions` 默认 `true`，只转发新消息中的真实 @Bot；`false` 转发收到的人类新消息。Admin 修改立即作用于后续消息，重启保留。代码块、行内代码、引用里的旧 @ 不触发。
- thread 消息仍属于原群或 DM，遵循同样的 @过滤；只保存 `features.thread_id = thread_ts`。Bot 历史发言不产生免 @接话资格。回复一律发到原会话主界面；显式 thread/quote/reply/换原生目标请求返回不支持。
- 出站纯文本/mention；超过 4000 字符顺序拆分，每个会话约每秒一条，限流后按 Retry-After 推迟后续发送。部分成功的真实 IDs 会随错误返回并记入缓存；结果未知不自动重发。
- 入站附件保留文字/文件名及“未读取”占位，不下载，不支持出站文件/图片、reaction、交互卡片或搜索。
- `get_history/get_message` 是本地交互缓存：只有通过过滤的入站和确认成功的出站，默认 30 天/每会话 1000 条，不是完整 Slack 群史/thread。过期或未缓存消息明确返回不可用。缓存清理按写入/查询和每小时执行。
- 联系人/群/群成员使用平台完整分页；缺权限返回错误。只枚举 Bot 已加入的群；成员 count 取实际枚举全集，角色保守返回 `member`，不把 workspace 管理员误标为群管理员。
- 实例数据存放于 Admin 注入的 `DATA_DIR`，不硬编码机器路径。`installation.json` 防止将同一实例切到另一安装，换 workspace/Bot 请新建实例。

## 配置与持久化

| Admin 启动字段 | 运行时字段 | 默认 | 生效 |
|---|---|---|---|
| SLACK_BOT_TOKEN | credentials.bot_token | 必填 | 重启 |
| SLACK_APP_TOKEN | credentials.app_token | 必填 | 重启 |
| SLACK_ONLY_RESPOND_TO_MENTIONS | group.only_respond_to_mentions | true | 热更新 |
| SLACK_CACHE_MAX_DAYS | cache.max_days | 30 | 下次清理 |
| SLACK_CACHE_MAX_MESSAGES | cache.max_messages_per_session | 1000 | 下次写入/清理 |

Token 查询掩码 `***` 不覆盖真值。模块按 base-protocol 先完整校验、原子写入实例 `config.json`，再应用热字段；Admin 同步其停机表单/重启 env。模块记录启动输入，未改变的 env 不覆盖已保存的运行值；停机表单明确修改的字段才覆盖对应持久值，其余字段保留。凭据文件权限为 0600；SDK 不输出原始 Token、Socket URL 或事件内容。

## 本地验证

使用仓库指定的 pnpm 和 Node 22：先在 `crabot-shared` 执行 `corepack pnpm install --frozen-lockfile && corepack pnpm run build`，再到本目录执行 `corepack pnpm install --frozen-lockfile && corepack pnpm run build && corepack pnpm test`。Admin 的 `src/channel-manager.slack.test.ts` 验证真实本地 HTTP RPC 保存与重启。

自动化使用 fake Slack 边界与临时实例目录，不访问真实 workspace、不调用模型。断线期间 Slack 未送达消息、ACK 后进程崩溃等不承诺完整补送或端到端恰好一次。上线前仍须用真实 App 验证 Token 配对、scope、DM/公开群/私有群和实际 Agent 消费及 Slack 投递。
