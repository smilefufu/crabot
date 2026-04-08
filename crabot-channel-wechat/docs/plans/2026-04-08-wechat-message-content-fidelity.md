# 微信消息内容完整传递 + get_message 兜底 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复微信各消息类型（链接、引用、名片、小程序等）在进入 Crabot 时内容丢失的问题；get_history 改为代理 wechat-connector API；新增 get_message 作为兜底查询能力。

**Architecture:** crabot-channel-wechat 不再自行存储消息，get_history/get_message 代理到 wechat-connector REST API。新增 `format-wechat-content.ts` 负责将 wechat-connector 结构化 content 转为 Markdown 文本，入站消息和历史查询复用同一套逻辑。Agent 侧新增 get_message front-tool。协议文档同步更新。

**Tech Stack:** TypeScript (Node.js), wechat-connector Bot REST API, Crabot Channel 协议

---

## 文件结构

### 新建文件
- `crabot-channel-wechat/src/format-wechat-content.ts` — 将 wechat-connector 结构化 content 转为 Markdown + Crabot MessageContent/MessageFeatures
- `wechat-connector/packages/server/src/modules/bot/bot.controller.ts` — 新增 getMessageById 函数（追加）

### 修改文件
- `crabot-channel-wechat/src/wechat-channel.ts` — 入站消息处理调用新格式化函数；get_history 改为代理 connector API；新增 get_message RPC handler；移除 MessageStore 依赖
- `crabot-channel-wechat/src/wechat-client.ts` — 新增 getMessageById()、改造 getMessages() 支持更多查询参数
- `crabot-channel-wechat/src/types.ts` — 新增 GetMessageParams / ConnectorMessage 类型
- `crabot-agent/src/agent/front-tools.ts` — 新增 GET_MESSAGE_TOOL
- `crabot-agent/src/agent/tool-executor.ts` — 新增 get_message case
- `crabot-agent/src/mcp/crab-messaging.ts` — 新增 get_message tool
- `crabot-docs/protocols/protocol-channel.md` — 新增 get_message RPC 定义
- `crabot-docs/protocols/protocol-crab-messaging.md` — get_history 返回补 quote_message_id；新增 get_message tool 定义
- `wechat-connector/packages/server/src/modules/bot/bot.routes.ts` — 新增路由

### 可删除文件
- `crabot-channel-wechat/src/message-store.ts` — 不再需要本地消息存储（在最后一个 Task 中移除）

---

## Task 1: wechat-connector 新增 GET /messages/:id

**Files:**
- Modify: `wechat-connector/packages/server/src/modules/bot/bot.controller.ts` (追加函数)
- Modify: `wechat-connector/packages/server/src/modules/bot/bot.routes.ts:36` (加路由)

- [ ] **Step 1: 在 bot.controller.ts 末尾新增 getMessageById**

```typescript
/**
 * GET /api/v1/bot/messages/:id - 按 ID 查询单条消息
 */
export async function getMessageById(req: BotAuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { puppetId } = req.botContext!;
    const { id } = req.params;

    const message = await prisma.message.findFirst({
      where: { id, puppetId },
      select: {
        id: true,
        fieldTalker: true,
        fieldIsSend: true,
        fieldCreateTime: true,
        fieldType: true,
        content: true,
      },
    });

    if (!message) {
      res.status(404).json({ code: -1, message: '消息不存在' });
      return;
    }

    res.json({
      code: 0,
      data: {
        ...message,
        fieldCreateTime: message.fieldCreateTime.toString(),
      },
    });
  } catch (error) {
    next(error);
  }
}
```

- [ ] **Step 2: 在 bot.routes.ts 第 36 行（`router.get('/messages/search', ...` 之前）插入路由**

注意：`:id` 路由必须在 `/messages/search` 和 `/messages/stats` 之后，否则 "search" 和 "stats" 会被当成 `:id` 参数匹配。在 `router.get('/messages/stats', ...)` 之后添加：

```typescript
router.get('/messages/:id', botController.getMessageById);
```

- [ ] **Step 3: 验证编译**

Run: `cd /Users/fufu/codes/playground/wechat-connector && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
cd /Users/fufu/codes/playground/wechat-connector
git add packages/server/src/modules/bot/bot.controller.ts packages/server/src/modules/bot/bot.routes.ts
git commit -m "feat(bot-api): add GET /messages/:id endpoint for single message lookup"
```

---

## Task 2: format-wechat-content.ts — 消息格式化核心

**Files:**
- Create: `crabot-channel-wechat/src/format-wechat-content.ts`

这是核心文件，将 wechat-connector 的结构化 content（`Record<string, unknown>`）转为 Crabot 的 `MessageContent` + `MessageFeatures`。入站消息和 get_history/get_message 复用此函数。

- [ ] **Step 1: 创建 format-wechat-content.ts**

```typescript
/**
 * format-wechat-content.ts
 *
 * 将 wechat-connector 结构化 content 转为 Crabot MessageContent + MessageFeatures。
 * 入站消息处理和 get_history/get_message 代理共用此逻辑。
 *
 * wechat-connector MessageType 枚举值参考:
 *   0=TEXT, 1=IMAGE, 2=VOICE, 3=CARD, 4=TRANSFER, 5=RED_PACKET,
 *   9=FILE, 10=VIDEO, 11=LINK, 15=MINI_PROGRAM, 17=PAT_PAT,
 *   18=QUOTE, 20=APP_MSG, 34=VOICE, 42=CARD, 43=VIDEO, 47=EMOJI
 */

import type { MessageContent, MessageFeatures, MessageType } from './types.js'

/** wechat-connector 返回的消息结构（getMessages / getMessageById） */
export interface ConnectorMessage {
  id: string
  fieldTalker: string
  fieldIsSend: number
  fieldCreateTime: string
  fieldType: number
  content: Record<string, unknown>
}

export interface FormattedMessage {
  content: MessageContent
  features: Partial<MessageFeatures>
}

/**
 * 将 wechat-connector 的结构化 content + fieldType 转为 Crabot 格式
 */
export function formatWechatContent(
  fieldType: number,
  raw: Record<string, unknown>,
): FormattedMessage {
  const s = (key: string): string | undefined => {
    const v = raw[key]
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  }

  switch (fieldType) {
    // ── 文本 ──
    case 0: {
      return textMsg(s('text') ?? '')
    }

    // ── 图片 ──
    case 1: {
      return {
        content: {
          type: 'image',
          text: '',
          media_url: s('resource_url'),
        },
        features: {},
      }
    }

    // ── 语音 (2, 34) ──
    case 2:
    case 34: {
      return textMsg('[语音消息]')
    }

    // ── 名片 (3, 42) ──
    case 3:
    case 42: {
      const nickname = s('nickname') ?? '未知'
      const alias = s('alias')
      const detail = alias ? `${nickname} (微信号: ${alias})` : nickname
      return textMsg(`**名片**: ${detail}`)
    }

    // ── 转账 ──
    case 4: {
      const amount = s('money_amount') ?? '?'
      const desc = s('money_desc')
      return textMsg(desc ? `**转账** ¥${amount}: ${desc}` : `**转账** ¥${amount}`)
    }

    // ── 红包 ──
    case 5: {
      const desc = s('money_desc')
      return textMsg(desc ? `**红包**: ${desc}` : '**红包**')
    }

    // ── 文件 (9, 1090519089) ──
    case 9:
    case 1090519089: {
      const fileName = s('file_name') ?? '未知文件'
      const fileUrl = s('file_url')
      const content: MessageContent = {
        type: 'file',
        text: fileName,
        ...(fileUrl ? { media_url: fileUrl } : {}),
        filename: fileName,
      }
      return { content, features: {} }
    }

    // ── 视频 (10, 43) ──
    case 10:
    case 43: {
      const videoUrl = s('video_url')
      const content: MessageContent = videoUrl
        ? { type: 'file', text: '视频', media_url: videoUrl, mime_type: 'video/mp4' }
        : { type: 'text', text: '[视频消息]' }
      return { content, features: {} }
    }

    // ── 链接 (11) ──
    case 11: {
      const title = s('title') ?? '链接'
      const url = s('url') ?? s('addUrl')
      const describe = s('describe')
      const parts: string[] = []
      parts.push(url ? `[${title}](${url})` : `**${title}**`)
      if (describe) parts.push(describe)
      return textMsg(parts.join('\n\n'))
    }

    // ── 小程序 (15) ──
    case 15: {
      const title = s('title') ?? '小程序'
      const des = s('des')
      const redirectUrl = s('redirectUrl')
      const parts: string[] = []
      parts.push(redirectUrl ? `[${title}](${redirectUrl})` : `**${title}**`)
      if (des) parts.push(des)
      return textMsg(parts.join('\n\n'))
    }

    // ── 拍一拍 (17) ──
    case 17: {
      return textMsg(s('text') ?? '[拍一拍]')
    }

    // ── 引用/回复 (18) ──
    case 18: {
      const text = s('text') ?? ''
      const quotedSender = s('quoted_sender_name')
      const quotedContent = s('quoted_content')
      const quotedSvrId = s('quoted_svr_id')

      const parts: string[] = []
      if (quotedSender || quotedContent) {
        const attribution = quotedSender ? `${quotedSender}: ` : ''
        parts.push(`> ${attribution}${quotedContent ?? '[消息]'}`)
        parts.push('')  // blank line after blockquote
      }
      parts.push(text)

      return {
        content: { type: 'text', text: parts.join('\n') },
        features: {
          ...(quotedSvrId ? { quote_message_id: quotedSvrId } : {}),
        },
      }
    }

    // ── 应用消息/聊天记录 (20) ──
    case 20: {
      const title = s('title')
      const describe = s('describe')
      const text = s('text')
      if (title) {
        const parts: string[] = [`**${title}**`]
        if (describe) parts.push(describe)
        return textMsg(parts.join('\n\n'))
      }
      // fallback: 直接用 text（可能是 XML）
      return textMsg(text ?? '[应用消息]')
    }

    // ── 表情 (47) ──
    case 47: {
      return textMsg('[表情]')
    }

    // ── 系统消息 (6, 10000, 10002) ──
    case 6:
    case 10000:
    case 10002: {
      return textMsg(`[系统消息]`)
    }

    // ── 未知类型 ──
    default: {
      const text = s('text')
      if (text) return textMsg(text)
      return textMsg(`[未知消息类型: ${fieldType}]`)
    }
  }
}

function textMsg(text: string): FormattedMessage {
  return {
    content: { type: 'text' as MessageType, text },
    features: {},
  }
}
```

- [ ] **Step 2: 验证编译**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-channel-wechat && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-channel-wechat
git add src/format-wechat-content.ts
git commit -m "feat: add format-wechat-content — Markdown formatting for all wechat message types"
```

---

## Task 3: wechat-client.ts — 新增 getMessageById，改造 getMessages

**Files:**
- Modify: `crabot-channel-wechat/src/wechat-client.ts:140-148`

- [ ] **Step 1: 新增 getMessageById 方法，改造 getMessages 支持 before/after 参数**

将 wechat-client.ts 第 140-148 行的 getMessages 替换为：

```typescript
  /**
   * 查询消息历史（代理 wechat-connector GET /api/v1/bot/messages）
   */
  async getMessages(params: {
    talker: string
    limit?: number
    before?: string
    after?: string
  }): Promise<Array<Record<string, unknown>>> {
    const qs = new URLSearchParams()
    qs.set('talker', params.talker)
    if (params.limit) qs.set('limit', String(params.limit))
    if (params.before) qs.set('before', params.before)
    if (params.after) qs.set('after', params.after)
    const result = await this.get<Array<Record<string, unknown>>>(
      `/api/v1/bot/messages?${qs.toString()}`
    )
    return result ?? []
  }

  /**
   * 按 ID 查询单条消息（代理 wechat-connector GET /api/v1/bot/messages/:id）
   */
  async getMessageById(id: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.get(`/api/v1/bot/messages/${encodeURIComponent(id)}`)
    } catch {
      return null
    }
  }
```

- [ ] **Step 2: 验证编译**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-channel-wechat && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-channel-wechat
git add src/wechat-client.ts
git commit -m "feat(wechat-client): add getMessageById, extend getMessages params"
```

---

## Task 4: wechat-channel.ts — 入站消息使用新格式化函数

**Files:**
- Modify: `crabot-channel-wechat/src/wechat-channel.ts:242-280`

- [ ] **Step 1: 添加 import**

在 `wechat-channel.ts` 的 import 区域（第 17 行 `import { WechatClient }` 之后）添加：

```typescript
import { formatWechatContent } from './format-wechat-content.js'
```

- [ ] **Step 2: 替换入站消息处理逻辑**

将 `wechat-channel.ts` 第 242-280 行替换为：

```typescript
    // 格式化消息内容（所有消息类型统一通过 formatWechatContent 处理）
    const msgType = event.message.type
    const rawContent = event.message.content as Record<string, unknown>
    const { content: formattedContent, features: extraFeatures } = formatWechatContent(msgType, rawContent)

    // 检测 @Crabot
    const atString = (rawContent.at_string as string | undefined) ?? ''
    const isMentionCrab = isGroup && atString.split(',').some(wxid => wxid.trim() === event.puppet.wxid)

    // 获取 Crabot 群昵称（仅群聊）
    const crabDisplayName = isGroup
      ? await this.getCrabGroupNick(platformSessionId, event.puppet.wxid)
      : undefined

    // 构建 ChannelMessage
    const channelMessage: ChannelMessage = {
      platform_message_id: event.message.id,
      session: {
        session_id: session.id,
        channel_id: this.config.moduleId,
        type: session.type,
      },
      sender: {
        platform_user_id: event.sender.wxid,
        platform_display_name: event.sender.name,
      },
      content: formattedContent,
      features: {
        is_mention_crab: isMentionCrab,
        ...extraFeatures,
      },
      platform_timestamp: generateTimestamp(),
    }
```

- [ ] **Step 3: 移除入站消息的 messageStore.appendInbound 调用**

删除第 284-292 行（`this.messageStore.appendInbound(...)` 调用块）。入站消息不再写本地存储。

- [ ] **Step 4: 验证编译**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-channel-wechat && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-channel-wechat
git add src/wechat-channel.ts
git commit -m "feat: inbound messages use formatWechatContent for all message types"
```

---

## Task 5: wechat-channel.ts — get_history 代理 wechat-connector API

**Files:**
- Modify: `crabot-channel-wechat/src/wechat-channel.ts` (handleGetHistory 方法)

- [ ] **Step 1: 重写 handleGetHistory**

将 `handleGetHistory` 方法整体替换为：

```typescript
  private async handleGetHistory(params: GetHistoryParams) {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throw new Error('Session not found')

    const talker = session.platform_session_id
    const limit = params.limit ?? params.pagination?.page_size ?? 20

    // 代理到 wechat-connector API
    const messages = await this.client.getMessages({
      talker,
      limit,
      before: params.time_range?.before,
      after: params.time_range?.after,
    })

    // 关键词过滤（connector API 不支持 keyword，本地过滤）
    let filtered = messages
    if (params.keyword) {
      const kw = params.keyword.toLowerCase()
      filtered = messages.filter((m) => {
        const content = m.content as Record<string, unknown> | undefined
        const text = (content?.text as string) ?? ''
        return text.toLowerCase().includes(kw)
      })
    }

    // 转换为协议格式，复用 formatWechatContent
    const protocolItems = filtered.map((m) => {
      const content = m.content as Record<string, unknown>
      const fieldType = (m.fieldType as number) ?? (content.type as number) ?? 0
      const isSend = (m.fieldIsSend as number) === 1
      const { content: msgContent, features } = formatWechatContent(fieldType, content)

      return {
        platform_message_id: m.id as string,
        sender: {
          platform_user_id: isSend ? '_self' : (content.group_sender as string ?? talker),
          platform_display_name: isSend ? 'bot' : (content.group_sender as string ?? talker),
        },
        content: msgContent,
        features: {
          is_mention_crab: false,
          ...features,
        },
        platform_timestamp: connectorTimeToISO(m.fieldCreateTime as string),
      }
    })

    return {
      items: protocolItems,
      pagination: {
        page: 1,
        page_size: limit,
        total_items: protocolItems.length,
        total_pages: 1,
      },
    }
  }
```

注意：wechat-connector 的 `fieldCreateTime` 是字符串化的毫秒时间戳（如 `"1712567890000"`），Crabot 协议要求 ISO 8601。需要在文件顶部添加辅助函数：

```typescript
/** wechat-connector 毫秒时间戳字符串 → ISO 8601 */
function connectorTimeToISO(ts: string): string {
  const ms = parseInt(ts, 10)
  return isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString()
}
```

此函数定义在 `wechat-channel.ts` 底部的工具函数区域（与 `messageTypeName` 同级）。

- [ ] **Step 2: 确保 formatWechatContent 已在文件顶部 import（Task 4 已添加）**

- [ ] **Step 3: 验证编译**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-channel-wechat && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-channel-wechat
git add src/wechat-channel.ts
git commit -m "refactor: get_history proxies to wechat-connector API instead of local store"
```

---

## Task 6: wechat-channel.ts — 新增 get_message RPC handler

**Files:**
- Modify: `crabot-channel-wechat/src/wechat-channel.ts` (registerMethods + 新方法)
- Modify: `crabot-channel-wechat/src/types.ts` (新增 GetMessageParams)

- [ ] **Step 1: 在 types.ts 末尾（`WechatChannelConfig` 之前）新增类型**

```typescript
export interface GetMessageParams {
  session_id: SessionId
  platform_message_id: string
}
```

- [ ] **Step 2: 在 wechat-channel.ts import 中加入 GetMessageParams**

在 import from './types.js' 的类型列表中添加 `GetMessageParams`。

- [ ] **Step 3: 在 registerMethods 中注册 get_message**

在 `this.registerMethod('get_history', ...)` 之后添加：

```typescript
    this.registerMethod('get_message', this.handleGetMessage.bind(this))
```

- [ ] **Step 4: 实现 handleGetMessage**

在 `handleGetHistory` 方法之后添加：

```typescript
  private async handleGetMessage(params: GetMessageParams) {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throw new Error('Session not found')

    const msg = await this.client.getMessageById(params.platform_message_id)
    if (!msg) throw new Error('Message not found')

    const content = msg.content as Record<string, unknown>
    const fieldType = (msg.fieldType as number) ?? (content.type as number) ?? 0
    const isSend = (msg.fieldIsSend as number) === 1
    const talker = session.platform_session_id
    const { content: msgContent, features } = formatWechatContent(fieldType, content)

    return {
      platform_message_id: msg.id as string,
      sender: {
        platform_user_id: isSend ? '_self' : (content.group_sender as string ?? talker),
        platform_display_name: isSend ? 'bot' : (content.group_sender as string ?? talker),
      },
      content: msgContent,
      features: {
        is_mention_crab: false,
        ...features,
      },
      platform_timestamp: connectorTimeToISO(msg.fieldCreateTime as string),
    }
  }
```

- [ ] **Step 5: 验证编译**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-channel-wechat && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-channel-wechat
git add src/wechat-channel.ts src/types.ts
git commit -m "feat: add get_message RPC handler — proxy to wechat-connector"
```

---

## Task 7: 移除 MessageStore 依赖

**Files:**
- Modify: `crabot-channel-wechat/src/wechat-channel.ts` (移除 import 和用法)
- Delete: `crabot-channel-wechat/src/message-store.ts`

- [ ] **Step 1: 从 wechat-channel.ts 移除 MessageStore**

1. 删除 import 行：`import { MessageStore } from './message-store.js'`
2. 删除字段声明：`private readonly messageStore: MessageStore`（约第 46 行）
3. 删除构造函数中的初始化：`this.messageStore = new MessageStore(config.data_dir)`（约第 77 行）
4. 删除 handleSendMessage 中的 `this.messageStore.appendOutbound(...)` 调用块（约第 387-393 行）

- [ ] **Step 2: 删除 message-store.ts**

```bash
rm /Users/fufu/codes/playground/crabot/crabot-channel-wechat/src/message-store.ts
```

- [ ] **Step 3: 验证编译**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-channel-wechat && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-channel-wechat
git add -A src/wechat-channel.ts src/message-store.ts
git commit -m "refactor: remove local MessageStore — messages served from wechat-connector"
```

---

## Task 8: crabot-agent — 新增 get_message front-tool

**Files:**
- Modify: `crabot-agent/src/agent/front-tools.ts:296-300`
- Modify: `crabot-agent/src/agent/tool-executor.ts:56-63`

- [ ] **Step 1: 在 front-tools.ts 的 GET_HISTORY_TOOL 之后添加 GET_MESSAGE_TOOL**

在 `GET_HISTORY_TOOL` 定义（第 217 行）之后添加：

```typescript
export const GET_MESSAGE_TOOL: ToolDefinition = {
  name: 'get_message',
  description: '按消息 ID 查询单条消息详情。当历史消息中某条消息的内容不完整时（如只显示占位符），可用此工具查看完整内容。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      channel_id: { type: 'string', description: 'Channel 模块实例 ID' },
      session_id: { type: 'string', description: 'Session ID' },
      platform_message_id: { type: 'string', description: '要查询的消息 ID' },
    },
    required: ['channel_id', 'session_id', 'platform_message_id'],
  },
  isReadOnly: true,
  call: NOOP_CALL,
}
```

- [ ] **Step 2: 在 getAllFrontTools 的返回数组中，GET_HISTORY_TOOL 之后添加 GET_MESSAGE_TOOL**

```typescript
    GET_HISTORY_TOOL,
    GET_MESSAGE_TOOL,
```

- [ ] **Step 3: 在 tool-executor.ts 的 switch 中添加 get_message case**

在 `case 'get_history': return await this.getHistory(input)` 之后添加：

```typescript
        case 'get_message': return await this.getMessage(input)
```

- [ ] **Step 4: 在 ToolExecutor 类中添加 getMessage 方法**

在 `getHistory` 方法之后添加：

```typescript
  private async getMessage(input: Record<string, unknown>): Promise<ToolResult> {
    const channelPort = await this.deps.resolveChannelPort(input.channel_id as string)
    const result = await this.deps.rpcClient.call<
      { session_id: string; platform_message_id: string },
      { platform_message_id: string; sender: { platform_user_id: string; platform_display_name: string }; content: { type: string; text?: string }; features: Record<string, unknown>; platform_timestamp: string }
    >(channelPort, 'get_message', {
      session_id: input.session_id as string,
      platform_message_id: input.platform_message_id as string,
    }, this.deps.moduleId)
    return { output: JSON.stringify(result), isError: false }
  }
```

- [ ] **Step 5: 验证编译**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-agent
git add src/agent/front-tools.ts src/agent/tool-executor.ts
git commit -m "feat: add get_message front-tool for single message lookup"
```

---

## Task 9: crabot-agent — crab-messaging MCP 新增 get_message tool

**Files:**
- Modify: `crabot-agent/src/mcp/crab-messaging.ts:583-586`

- [ ] **Step 1: 在 crab-messaging.ts 的 get_history tool 注册之后（第 583 行 `)` 之前），添加 get_message tool**

在 `// 6. get_history` 块的 `)` 之后，`return server` 之前，添加：

```typescript

      // ================================================================
      // 7. get_message — 按 ID 查询单条消息
      // ================================================================
  server.tool(
        'get_message',
        '按消息 ID 查询单条消息详情。当消息内容不完整时可用此工具查看完整内容。',
        {
          channel_id: z.string().describe('Channel 模块实例 ID'),
          session_id: z.string().describe('Session ID'),
          platform_message_id: z.string().describe('要查询的消息 ID'),
        },
        async (args) => {
          try {
            const channelPort = await resolveChannelPort(args.channel_id)
            if (!channelPort) {
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ error: `Channel ${args.channel_id} 不可用` }) }],
              }
            }

            const result = await rpcClient.call<
              { session_id: string; platform_message_id: string },
              {
                platform_message_id: string
                sender: { platform_user_id: string; platform_display_name: string }
                content: { type: string; text?: string; media_url?: string }
                features: Record<string, unknown>
                platform_timestamp: string
              }
            >(channelPort, 'get_message', {
              session_id: args.session_id,
              platform_message_id: args.platform_message_id,
            }, moduleId)

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `查询消息失败: ${msg}` }) }],
            }
          }
        },
  )
```

- [ ] **Step 2: 更新文件顶部注释**

将第 4 行的工具列表注释更新为：

```typescript
 * 提供 8 个工具：lookup_friend, list_contacts, list_groups, list_sessions, open_private_session, send_message, get_history, get_message
```

- [ ] **Step 3: 验证编译**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-agent
git add src/mcp/crab-messaging.ts
git commit -m "feat(crab-messaging): add get_message MCP tool"
```

---

## Task 10: 协议文档更新

**Files:**
- Modify: `crabot-docs/protocols/protocol-channel.md` (§3.3 之后新增 §3.x)
- Modify: `crabot-docs/protocols/protocol-crab-messaging.md` (§2.5 返回补字段 + 新增 §2.x)

- [ ] **Step 1: protocol-channel.md — 在 §3.3 get_history 之后（第 267 行 `---` 之后，§3.4 之前）插入 get_message 定义**

```markdown
### 3.4 get_message — 查询单条消息

按平台消息 ID 查询单条消息的完整内容。当 Agent 拿到消息 ID（如 get_history 中的 `platform_message_id`，或引用消息的 `quote_message_id`）但内容不完整时，用此方法获取详情。

- **方向**：Agent / Admin → Channel
- **模式**：同步

**请求参数**：

```typescript
interface GetMessageParams {
  session_id: SessionId
  /** 要查询的平台消息 ID */
  platform_message_id: string
}
```

**响应数据**：

```typescript
type GetMessageResult = HistoryMessage
```

返回与 `get_history` 中相同的 `HistoryMessage` 结构。

**错误码**：

| 错误码 | 说明 |
|--------|------|
| `NOT_FOUND` | Session 或消息不存在 |
| `CHANNEL_HISTORY_UNAVAILABLE` | Channel 不支持消息查询 |
```

注意：原来的 §3.4（get_platform_user_info）需要改为 §3.5，后续章节号顺延。

- [ ] **Step 2: protocol-crab-messaging.md — 在 §2.5 get_history 的返回结构中补充 quote_message_id**

将 protocol-crab-messaging.md 第 334-344 行的 `GetHistoryOutput` 替换为：

```typescript
interface GetHistoryOutput {
  messages: Array<{
    platform_message_id: string
    sender_name: string
    sender_friend_id?: FriendId
    content: string
    content_type: MessageType
    timestamp: string
    /** 引用回复的原始消息 ID（如果此消息是引用回复） */
    quote_message_id?: string
  }>
}
```

- [ ] **Step 3: protocol-crab-messaging.md — 在 §2.5 之后、§2.6 list_contacts 之前插入 get_message tool 定义**

```markdown
### 2.6 get_message — 查询单条消息详情

按消息 ID 查询一条消息的完整内容。用于消息内容不完整时的兜底查询。

**参数**：

```typescript
interface GetMessageInput {
  /** Channel 模块实例 ID */
  channel_id: ModuleId
  /** Session ID */
  session_id: SessionId
  /** 要查询的平台消息 ID */
  platform_message_id: string
}
```

**返回**：

```typescript
interface GetMessageOutput {
  platform_message_id: string
  sender_name: string
  sender_friend_id?: FriendId
  content: string
  content_type: MessageType
  timestamp: string
  quote_message_id?: string
}
```

**错误**：

| 错误 | 说明 |
|------|------|
| 消息不存在 | 指定的消息 ID 在该 Channel 上不存在 |
| Channel 不可用 | 指定的 Channel 未运行或不存在 |

**实现**：委托目标 Channel 的 `get_message` 接口。
```

注意：原来的 §2.6（list_contacts）需要改为 §2.7，后续章节号顺延。

- [ ] **Step 4: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-docs
git add protocols/protocol-channel.md protocols/protocol-crab-messaging.md
git commit -m "docs: add get_message to channel and crab-messaging protocols; add quote_message_id to get_history output"
```

---

## Task 11: 端到端验证

- [ ] **Step 1: 构建所有改动的模块**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-channel-wechat && npm run build
cd /Users/fufu/codes/playground/crabot/crabot-agent && npm run build
```

Expected: 两个模块编译成功

- [ ] **Step 2: 启动开发环境并发送测试消息**

```bash
cd /Users/fufu/codes/playground/crabot && ./dev.sh
```

在微信群中测试以下场景：
1. 发送一个链接 → Agent 应能看到 `[标题](url)` 格式的 Markdown 内容
2. 引用回复一条消息 → Agent 应能看到 `> 发送者: 内容` + 回复正文，且 features 中有 `quote_message_id`
3. 发送名片 → Agent 应能看到 `**名片**: 昵称`
4. @ Agent 并问"刚才那个链接是什么" → Agent 调 get_history 应能拿到完整链接内容
5. 用 get_message 工具查一条历史消息 → 应返回完整内容

- [ ] **Step 3: 确认 wechat-connector 的 GET /messages/:id 能正常工作**

```bash
curl -H "Authorization: Bearer <api-key>" http://localhost:<port>/api/v1/bot/messages/<message-id>
```

Expected: 返回 `{ code: 0, data: { id, fieldType, content, ... } }`
