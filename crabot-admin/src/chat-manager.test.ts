/**
 * ChatManager.handleSendMessage（admin-web 伪 channel 入口）单元测试
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ChatManager, buildChatTaskSnapshot } from './chat-manager.js'
import { MediaStore } from './media-store.js'
import type { Task } from './types.js'

const TEST_DATA_DIR = './test-data/chat-manager-send-test'

/** 创建注入 MediaStore 的 ChatManager（async） */
async function makeManager(): Promise<ChatManager> {
  const store = new MediaStore(TEST_DATA_DIR)
  await store.init()
  return new ChatManager(
    TEST_DATA_DIR,
    { call: async () => ({}) } as never,
    async () => 0,
    'test-secret',
    async () => ({ sub: 'admin' }),
    store,
  )
}

/** 创建注入可观察 rpc stub 的 ChatManager（async） */
async function makeManagerWithRpc(
  rpcCall: (port: number, method: string, params: unknown) => Promise<unknown>,
): Promise<ChatManager> {
  const store = new MediaStore(TEST_DATA_DIR)
  await store.init()
  return new ChatManager(
    TEST_DATA_DIR,
    { call: rpcCall } as never,
    async () => 42, // 非零端口，让 dispatchToAgent 正常往下走
    'test-secret',
    async () => ({ sub: 'admin' }),
    store,
  )
}

describe('ChatManager.handleSendMessage', () => {
  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  it('text 消息：落库 assistant 消息并返回 id/时间戳', async () => {
    const mgr = await makeManager()
    const result = await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'text', text: '任务完成，结果如下…' },
    })
    expect(result.platform_message_id).toBeTruthy()
    expect(result.sent_at).toBeTruthy()

    const stored = mgr.getMessages(10)
    expect(stored).toHaveLength(1)
    expect(stored[0].role).toBe('assistant')
    expect(stored[0].content.text).toBe('任务完成，结果如下…')
  })

  it('未知 session_id 抛错且不落库', async () => {
    const mgr = await makeManager()
    await expect(
      mgr.handleSendMessage({ session_id: 'wechat-xyz', content: { type: 'text', text: 'hi' } })
    ).rejects.toThrow(/Unknown chat session/)
    expect(mgr.getMessages(10)).toHaveLength(0)
  })

  it('system_event 内容直接透出 text（不降级为媒体占位）', async () => {
    const mgr = await makeManager()
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'system_event', text: '成员加入：小明' },
    })
    expect(mgr.getMessages(10)[0].content.text).toBe('成员加入：小明')
  })

  it('WS send 同步抛错时推送 best-effort 吞错，不污染调用方', async () => {
    const mgr = await makeManager()
    ;(mgr as unknown as { activeClient: unknown }).activeClient = {
      readyState: 1, // WebSocket.OPEN
      send: () => { throw new Error('socket closing') },
    }
    // handleSendMessage（内部 pushToClient）与 pushTaskUpdate 都不应抛错
    await expect(
      mgr.handleSendMessage({ session_id: 'admin-chat', content: { type: 'text', text: 'ok' } })
    ).resolves.toBeTruthy()
    expect(() =>
      mgr.pushTaskUpdate({ task_id: 't1' as never, status: 'executing' as never, title: 'x' })
    ).not.toThrow()
  })

  it('空文本抛错', async () => {
    const mgr = await makeManager()
    await expect(
      mgr.handleSendMessage({ session_id: 'admin-chat', content: { type: 'text', text: '  ' } })
    ).rejects.toThrow(/Empty message content/)
  })

  it('持久化：新实例 loadData 后可见', async () => {
    const mgr = await makeManager()
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'text', text: 'persisted' },
    })
    const mgr2 = await makeManager()
    await mgr2.loadData()
    expect(mgr2.getMessages(10)[0].content.text).toBe('persisted')
  })
})

describe('ChatMessage content 模型升级', () => {
  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
  })

  it('loadData hydrate：旧 string content 升级为 {type:text,text}', async () => {
    await fs.writeFile(
      `${TEST_DATA_DIR}/chat_messages.json`,
      JSON.stringify([{ message_id: 'old-1', role: 'user', content: '旧消息', timestamp: '2026-05-19T00:00:00Z' }]),
      'utf-8'
    )
    const mgr = await makeManager()
    await mgr.loadData()
    const [msg] = mgr.getMessages(10)
    expect(msg.content).toEqual({ type: 'text', text: '旧消息' })
  })

  it('handleSendMessage 落库的 content 是 MessageContent 结构', async () => {
    const mgr = await makeManager()
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'text', text: '结构化' },
    })
    expect(mgr.getMessages(10)[0].content.text).toBe('结构化')
    expect(mgr.getMessages(10)[0].content.type).toBe('text')
  })
})

describe('入站带附件消息（handleInboundMessage）', () => {
  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  it('process_message RPC 失败：消息仍落库、推 chat_error、不抛回调用方', async () => {
    const mgr = await makeManagerWithRpc(async () => {
      throw new Error('agent down')
    })
    const pushed: Array<{ type: string }> = []
    ;(mgr as unknown as { activeClient: unknown }).activeClient = {
      readyState: 1, // WebSocket.OPEN
      send: (data: string) => { pushed.push(JSON.parse(data)) },
    }
    const result = await mgr.handleInboundMessage({
      request_id: 'req-err',
      text: '会失败的消息',
      files: [],
    })
    // user 消息已落库且正常返回（失败非原子是已登记的设计取舍）
    expect(result.message.content.text).toBe('会失败的消息')
    expect(mgr.getMessages(10)).toHaveLength(1)
    // 推送序列：chat_status processing → chat_error
    expect(pushed.map((p) => p.type)).toEqual(['chat_status', 'chat_error'])
  })

  it('文字+附件：附件落 store，落库 content 含 media[]（URL 形态），process_message 收到绝对路径版', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const mgr = await makeManagerWithRpc(async (_port: number, method: string, params: unknown) => {
      calls.push({ method, params })
      return {}
    })
    const result = await mgr.handleInboundMessage({
      request_id: 'req-1',
      text: '看下这两张图',
      files: [
        { buffer: Buffer.from('img1'), filename: 'a.png', mime_type: 'image/png' },
        { buffer: Buffer.from('img2'), filename: 'b.jpg', mime_type: 'image/jpeg' },
      ],
    })
    // 落库消息：URL 形态 media[]
    expect(result.message.content.type).toBe('image')
    expect(result.message.content.text).toBe('看下这两张图')
    expect(result.message.content.media).toHaveLength(2)
    expect(result.message.content.media![0].media_url).toMatch(/^\/api\/media\//)
    // process_message：绝对路径版 + media_url 镜像
    const pm = calls.find((c) => c.method === 'process_message')
    expect(pm).toBeTruthy()
    const sentContent = (pm!.params as { message: { content: { media: Array<{ media_url: string }>; media_url: string } } }).message.content
    expect(sentContent.media).toHaveLength(2)
    expect(path.isAbsolute(sentContent.media[0].media_url)).toBe(true)
    expect(sentContent.media_url).toBe(sentContent.media[0].media_url)
  })

  it('空文本且无附件 → 抛错', async () => {
    const mgr = await makeManager()
    await expect(mgr.handleInboundMessage({ request_id: 'r', text: ' ', files: [] })).rejects.toThrow()
  })
})

describe('出站媒体收存（handleSendMessage Phase 2）', () => {
  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  it('file_path → 收存进 store，落库 media[] 为 store URL', async () => {
    const mgr = await makeManager()
    const src = path.join(TEST_DATA_DIR, 'shot.png')
    await fs.writeFile(src, 'png-bytes')
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'image', file_path: src, filename: 'shot.png', mime_type: 'image/png', text: '截图说明' },
    })
    const [msg] = mgr.getMessages(10)
    expect(msg.content.type).toBe('image')
    expect(msg.content.text).toBe('截图说明')
    expect(msg.content.media![0].media_url).toMatch(/^\/api\/media\//)
  })

  it('image file_path 未传 mime_type 时按扩展名识别为图片', async () => {
    const mgr = await makeManager()
    const src = path.join(TEST_DATA_DIR, 'generated.png')
    await fs.writeFile(src, 'png-bytes')
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'image', file_path: src, filename: '生成图.png' },
    })
    const [msg] = mgr.getMessages(10)
    expect(msg.content.type).toBe('image')
    expect(msg.content.media![0].mime_type).toBe('image/png')
  })

  it('http URL → 直接存引用不下载', async () => {
    const mgr = await makeManager()
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'image', media_url: 'https://example.com/x.png', mime_type: 'image/png' },
    })
    expect(mgr.getMessages(10)[0].content.media![0].media_url).toBe('https://example.com/x.png')
  })

  it('收存失败（文件不存在）→ 降级为文本说明，不丢消息', async () => {
    const mgr = await makeManager()
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'file', file_path: '/no/such/file.bin', filename: 'gone.bin', text: '正文' },
    })
    const [msg] = mgr.getMessages(10)
    expect(msg.content.media ?? []).toHaveLength(0)
    expect(msg.content.text).toContain('正文')
    expect(msg.content.text).toContain('gone.bin')
  })
})

describe('tagMessageTask / tagUserMessageByRequestId', () => {
  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  /** 捕获推送的 helper */
  function attachClientStub(mgr: ChatManager): Array<{ type: string; [k: string]: unknown }> {
    const pushed: Array<{ type: string; [k: string]: unknown }> = []
    ;(mgr as unknown as { activeClient: unknown }).activeClient = {
      readyState: 1, // WebSocket.OPEN
      send: (data: string) => { pushed.push(JSON.parse(data)) },
    }
    return pushed
  }

  it('tagMessageTask：命中已落库消息，回填 task_id + 广播 chat_message_tagged', async () => {
    const mgr = await makeManager()
    // 先通过 handleInboundMessage 存入 user 消息，避免 RPC（端口 0 会失败，静默处理）
    // 直接操作内部 messages 构造已落库的消息
    const pushed = attachClientStub(mgr)
    const result = await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'text', text: '测试消息' },
    })
    const msgId = result.platform_message_id
    // 回填
    const hit = await mgr.tagMessageTask(msgId, 'task-001' as never)
    expect(hit).toBe(true)
    // 验证消息 task_id 已写入
    const msgs = mgr.getMessages(10)
    expect(msgs[0].task_id).toBe('task-001')
    // 验证推送：handleSendMessage 推了 chat_push，tagMessageTask 又推了 chat_message_tagged
    const tagged = pushed.filter((p) => p.type === 'chat_message_tagged')
    expect(tagged).toHaveLength(1)
    expect(tagged[0].message_id).toBe(msgId)
    expect(tagged[0].task_id).toBe('task-001')
  })

  it('tagMessageTask：未命中时返回 false，不广播', async () => {
    const mgr = await makeManager()
    const pushed = attachClientStub(mgr)
    const hit = await mgr.tagMessageTask('nonexistent-id', 'task-002' as never)
    expect(hit).toBe(false)
    expect(pushed.filter((p) => p.type === 'chat_message_tagged')).toHaveLength(0)
  })

  it('tagMessageTask：幂等——已是同 task_id 时不重写不重推', async () => {
    const mgr = await makeManager()
    const result = await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'text', text: '测试幂等' },
    })
    const msgId = result.platform_message_id
    await mgr.tagMessageTask(msgId, 'task-003' as never)
    const pushed = attachClientStub(mgr) // 重新 attach，清空已有推送
    // 第二次调用：相同 task_id，不应再推送
    const hit = await mgr.tagMessageTask(msgId, 'task-003' as never)
    expect(hit).toBe(true)
    expect(pushed.filter((p) => p.type === 'chat_message_tagged')).toHaveLength(0)
  })

  it('tagUserMessageByRequestId：只命中 user 角色的同 request_id 消息', async () => {
    const mgr = await makeManager()
    const pushed = attachClientStub(mgr)
    // 手动构造两条消息：一条 user、一条 assistant，都带同一 request_id
    const userResult = await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'text', text: 'user-msg' },
    })
    const userMsgId = userResult.platform_message_id
    // 修改这条消息的 role 为 user（handleSendMessage 落的是 assistant，通过内部 messages 修改）
    // 改为用测试帮助函数直接注入 user 消息
    // 重新构造：先 loadData 读出，再模拟（由于实现复杂度，用内部 map 直接注入）
    // 访问私有 messages map 做测试
    const internalMessages = (mgr as unknown as { messages: Map<string, { message_id: string; role: string; content: unknown; request_id?: string; task_id?: string; timestamp: string }> }).messages
    // 修改 userResult 的 role 为 user，加 request_id
    const existing = internalMessages.get(userMsgId)!
    internalMessages.set(userMsgId, { ...existing, role: 'user', request_id: 'req-xyz' })
    // 加一条 assistant 消息带同一 request_id
    internalMessages.set('asst-001', {
      message_id: 'asst-001',
      role: 'assistant',
      content: { type: 'text', text: 'reply' },
      request_id: 'req-xyz',
      timestamp: new Date().toISOString(),
    })

    pushed.length = 0 // 清空
    await mgr.tagUserMessageByRequestId('req-xyz', 'task-xyz' as never)

    // 仅 user 消息被打标
    const updatedUser = internalMessages.get(userMsgId)!
    expect(updatedUser.task_id).toBe('task-xyz')
    const updatedAsst = internalMessages.get('asst-001')!
    expect(updatedAsst.task_id).toBeUndefined()
    // 推送只有一条
    expect(pushed.filter((p) => p.type === 'chat_message_tagged')).toHaveLength(1)
  })

  it('handleChatCallback 带 task_id 时：回填同 request_id 的 user 消息', async () => {
    const mgr = await makeManagerWithRpc(async () => ({}))
    const pushed = attachClientStub(mgr)

    // 通过 handleInboundMessage 创建 user 消息（会失败 process_message 但消息已落库）
    const { message: userMsg } = await mgr.handleInboundMessage({
      request_id: 'req-cb-1',
      text: '发一条会派 task 的消息',
      files: [],
    })
    pushed.length = 0 // 清空处理中推送

    // 模拟 chat_callback 回执带 task_id
    await mgr.handleChatCallback({
      request_id: 'req-cb-1',
      reply_type: 'task_created',
      content: '已创建任务：调查某事',
      task_id: 'task-cb-1' as never,
    })

    // user 消息应被打标
    const msgs = mgr.getMessages(20)
    const u = msgs.find((m) => m.message_id === userMsg.message_id)
    expect(u?.task_id).toBe('task-cb-1')
    // 应有 chat_message_tagged 推送
    expect(pushed.some((p) => p.type === 'chat_message_tagged' && p.task_id === 'task-cb-1')).toBe(true)
  })
})

/**
 * PR J：manager 正常回复走 send_message → chat_push，前端要靠 request_id 才能把
 * 「处理中」占位气泡收口。admin 侧的职责是给落库消息盖上当时 in-flight 的 request_id。
 */
describe('chat_push 收口占位：storeAssistantMessage 认领 in-flight request_id', () => {
  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  function attachClientStub(mgr: ChatManager): Array<{ type: string; [k: string]: unknown }> {
    const pushed: Array<{ type: string; [k: string]: unknown }> = []
    ;(mgr as unknown as { activeClient: unknown }).activeClient = {
      readyState: 1, // WebSocket.OPEN
      send: (data: string) => { pushed.push(JSON.parse(data)) },
    }
    return pushed
  }

  /**
   * 造出一条 in-flight 请求（pendingRequests 有条目、占位气泡已生出）。
   *
   * **`process_message` 停在飞行中不 resolve** —— 生产上就是这个形状：manager 的
   * `send_message` 发生在 episode 内部，也就是 `process_message` 返回**之前**
   * （`unified-agent.processAdminChatMessage` 整段 await 了 episode）。in-flight 窗口精确
   * 等于这次 RPC 的生命周期，测试必须在窗口内发回复，否则测的是一个生产上不存在的时序。
   * 收尾用 `finish()` 让 RPC 落地（= episode 结束）。
   */
  async function makeInFlight(requestId: string): Promise<{
    mgr: ChatManager
    pushed: Array<{ type: string; [k: string]: unknown }>
    finish: () => Promise<void>
  }> {
    let release!: () => void
    const rpcDone = new Promise<void>((resolve) => { release = resolve })
    const mgr = await makeManagerWithRpc(async () => { await rpcDone; return {} })
    const pushed = attachClientStub(mgr)
    const inbound = mgr.handleInboundMessage({ request_id: requestId, text: '帮我看下这个', files: [] })
    await vi.waitFor(() => expect(pushed.some((p) => p.type === 'chat_status' && p.request_id === requestId)).toBe(true))
    pushed.length = 0
    return {
      mgr,
      pushed,
      finish: async () => { release(); await inbound },
    }
  }

  it('正常回复：落库消息与 chat_push 载荷都盖上 in-flight 的 request_id', async () => {
    const { mgr, pushed, finish } = await makeInFlight('req-inflight-1')
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'text', text: '看完了，结论是……' },
    })
    const stored = mgr.getMessages(10).find((m) => m.role === 'assistant')
    expect(stored?.request_id).toBe('req-inflight-1')
    const push = pushed.find((p) => p.type === 'chat_push')
    expect(push).toBeTruthy()
    expect((push as { message: { request_id?: string } }).message.request_id).toBe('req-inflight-1')
    await finish()
  })

  it('带 media 的正常回复：chat_push 仍是完整 ChatMessage（media 不丢）且带 request_id', async () => {
    const { mgr, pushed, finish } = await makeInFlight('req-inflight-media')
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: {
        type: 'image',
        text: '图在这',
        media: [{ media_url: 'https://example.com/a.png', mime_type: 'image/png' }],
      },
    })
    const push = pushed.find((p) => p.type === 'chat_push') as
      { message: { request_id?: string; content: { media?: unknown[] } } }
    expect(push.message.request_id).toBe('req-inflight-media')
    expect(push.message.content.media).toHaveLength(1)
    await finish()
  })

  it('无 in-flight（manager 主动推送）：不盖 request_id，前端据此纯追加', async () => {
    const mgr = await makeManager()
    const pushed = attachClientStub(mgr)
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'text', text: '顺嘴提醒你一句' },
    })
    expect(mgr.getMessages(10)[0].request_id).toBeUndefined()
    const push = pushed.find((p) => p.type === 'chat_push') as { message: { request_id?: string } }
    expect(push.message.request_id).toBeUndefined()
  })

  it('一轮多条回复：认领即消费——只有第一条带 request_id，后续几条不带', async () => {
    const { mgr, pushed, finish } = await makeInFlight('req-inflight-2')
    await mgr.handleSendMessage({ session_id: 'admin-chat', content: { type: 'text', text: '收到，我去办' } })
    await mgr.handleSendMessage({ session_id: 'admin-chat', content: { type: 'text', text: '办好了' } })
    const pushes = pushed.filter((p) => p.type === 'chat_push') as Array<{ message: { request_id?: string } }>
    expect(pushes).toHaveLength(2)
    expect(pushes[0].message.request_id).toBe('req-inflight-2')
    expect(pushes[1].message.request_id).toBeUndefined()
    await finish()
  })

  it('两条 in-flight：按 FIFO 认领（最早那条最先被回答）', async () => {
    // 两条都停在飞行中（生产上就是两个 episode 同时在跑），回复在窗口内发出
    let release!: () => void
    const rpcDone = new Promise<void>((resolve) => { release = resolve })
    const mgr = await makeManagerWithRpc(async () => { await rpcDone; return {} })
    const pushed = attachClientStub(mgr)
    const a = mgr.handleInboundMessage({ request_id: 'req-a', text: '第一问', files: [] })
    await vi.waitFor(() => expect(pushed.filter((p) => p.type === 'chat_status')).toHaveLength(1))
    const b = mgr.handleInboundMessage({ request_id: 'req-b', text: '第二问', files: [] })
    await vi.waitFor(() => expect(pushed.filter((p) => p.type === 'chat_status')).toHaveLength(2))
    pushed.length = 0
    await mgr.handleSendMessage({ session_id: 'admin-chat', content: { type: 'text', text: '答第一问' } })
    await mgr.handleSendMessage({ session_id: 'admin-chat', content: { type: 'text', text: '答第二问' } })
    const pushes = pushed.filter((p) => p.type === 'chat_push') as Array<{ message: { request_id?: string } }>
    expect(pushes.map((p) => p.message.request_id)).toEqual(['req-a', 'req-b'])
    release()
    await Promise.all([a, b])
  })

  it('session_id=system-tasks：不认领 Master Chat 的 in-flight request', async () => {
    const { mgr, pushed, finish } = await makeInFlight('req-inflight-3')
    await mgr.handleSendMessage({ session_id: 'system-tasks', content: { type: 'text', text: '系统线程的消息' } })
    const push = pushed.find((p) => p.type === 'chat_push') as { message: { request_id?: string } }
    expect(push.message.request_id).toBeUndefined()
    // in-flight 没被吃掉：随后 admin-chat 的回复照样能认领到
    pushed.length = 0
    await mgr.handleSendMessage({ session_id: 'admin-chat', content: { type: 'text', text: '给人类的回复' } })
    const push2 = pushed.find((p) => p.type === 'chat_push') as { message: { request_id?: string } }
    expect(push2.message.request_id).toBe('req-inflight-3')
    await finish()
  })

  // --- PR #59 review 第二条：F3（episode 跑完但一句话没说）不得留下永久残骸 ---

  it('沉默 episode（F3）之后再发一条：回复认领的是新请求，旧的不残留、不错位', async () => {
    // 第一问：agent 侧 F3——`process_message` 正常返回，没有 chat_callback、也没有 send_message。
    const mgr = await makeManagerWithRpc(async () => ({ decision_types: [] }))
    const pushed = attachClientStub(mgr)
    await mgr.handleInboundMessage({ request_id: 'req-silent', text: '第一问（会被沉默）', files: [] })

    // 第二问：这一轮 manager 在 episode 内（= RPC 返回之前）回了话。
    let release!: () => void
    const rpcDone = new Promise<void>((resolve) => { release = resolve })
    ;(mgr as unknown as { rpcClient: { call: unknown } }).rpcClient = {
      call: async () => { await rpcDone; return {} },
    }
    const second = mgr.handleInboundMessage({ request_id: 'req-2', text: '第二问', files: [] })
    await vi.waitFor(() => expect(pushed.some((p) => p.type === 'chat_status' && p.request_id === 'req-2')).toBe(true))
    await mgr.handleSendMessage({ session_id: 'admin-chat', content: { type: 'text', text: '答第二问' } })
    release()
    await second

    // 认领的是第二问：占位气泡按 req-2 收口。修复前这里会认领早已收口无望的 req-silent，
    // 于是第一问的占位被换成第二问的答案、第二问的占位永远转圈（且此后整体错位一位）。
    const push = pushed.find((p) => p.type === 'chat_push') as { message: { request_id?: string } }
    expect(push.message.request_id).toBe('req-2')
    const stored = mgr.getMessages(10).find((m) => m.role === 'assistant')
    expect(stored?.request_id).toBe('req-2')
  })

  it('沉默 episode（F3）之后 manager 主动推送：没有可认领的 in-flight，纯追加', async () => {
    const mgr = await makeManagerWithRpc(async () => ({ decision_types: [] }))
    await mgr.handleInboundMessage({ request_id: 'req-silent-2', text: '会被沉默的一问', files: [] })
    const pushed = attachClientStub(mgr)

    await mgr.handleSendMessage({ session_id: 'admin-chat', content: { type: 'text', text: '顺嘴提醒你一句' } })

    const push = pushed.find((p) => p.type === 'chat_push') as { message: { request_id?: string } }
    expect(push.message.request_id).toBeUndefined()
  })

  it('失败兜底路径不受影响：chat_callback 仍按 request_id 推 chat_reply', async () => {
    const { mgr, pushed, finish } = await makeInFlight('req-inflight-4')
    await mgr.handleChatCallback({
      request_id: 'req-inflight-4',
      reply_type: 'direct_reply',
      content: '我这条消息没处理完，暂时回不了你。',
    })
    const reply = pushed.find((p) => p.type === 'chat_reply')
    expect(reply).toBeTruthy()
    expect(reply!.request_id).toBe('req-inflight-4')
    expect(reply!.status).toBe('completed')
    // 兜底消息落库也带 request_id（前端 15 秒兜底轮询按它匹配）
    const stored = mgr.getMessages(10).find((m) => m.role === 'assistant')
    expect(stored?.request_id).toBe('req-inflight-4')
    await finish()
  })
})

describe('deleteMessage', () => {
  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  /** 捕获推送的 helper（复用 tagMessageTask 区的写法） */
  function attachClientStub(mgr: ChatManager): Array<{ type: string; [k: string]: unknown }> {
    const pushed: Array<{ type: string; [k: string]: unknown }> = []
    ;(mgr as unknown as { activeClient: unknown }).activeClient = {
      readyState: 1, // WebSocket.OPEN
      send: (data: string) => { pushed.push(JSON.parse(data)) },
    }
    return pushed
  }

  it('命中：消息从 getMessages 消失 + 推送 chat_message_deleted + 返回 true', async () => {
    const mgr = await makeManager()
    const pushed = attachClientStub(mgr)
    const { platform_message_id } = await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'text', text: '待删除的消息' },
    })
    pushed.length = 0 // 清空 handleSendMessage 产生的推送

    const ok = await mgr.deleteMessage(platform_message_id)
    expect(ok).toBe(true)
    expect(mgr.getMessages(10)).toHaveLength(0)
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toMatchObject({ type: 'chat_message_deleted', message_id: platform_message_id })
  })

  it('未命中（不存在 id）：返回 false，不推送', async () => {
    const mgr = await makeManager()
    const pushed = attachClientStub(mgr)
    const ok = await mgr.deleteMessage('nonexistent-id')
    expect(ok).toBe(false)
    expect(pushed.filter((p) => p.type === 'chat_message_deleted')).toHaveLength(0)
  })

  it('持久化：删除后新实例 loadData 不含该消息', async () => {
    const mgr = await makeManager()
    const { platform_message_id } = await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'text', text: '持久化删除测试' },
    })
    await mgr.deleteMessage(platform_message_id)

    const mgr2 = await makeManager()
    await mgr2.loadData()
    expect(mgr2.getMessages(10)).toHaveLength(0)
  })
})

describe('buildChatTaskSnapshot', () => {
  const baseTask = {
    id: 'task-1',
    status: 'executing',
    priority: 'normal',
    title: '调查 X',
    source: { trigger_type: 'message', channel_id: 'admin-web' },
    messages: [],
    tags: [],
    created_at: '2026-06-10T00:00:00Z',
    updated_at: '2026-06-10T00:00:00Z',
  } as unknown as Task

  it('无 plan：只有 task_id/status/title', () => {
    const snap = buildChatTaskSnapshot(baseTask)
    expect(snap).toEqual({ task_id: 'task-1', status: 'executing', title: '调查 X' })
  })

  it('有 plan：带当前步骤', () => {
    const task = {
      ...baseTask,
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', description: '第一步', status: 'completed', retry_count: 0 },
          { id: 's2', description: '第二步', status: 'in_progress', retry_count: 0 },
        ],
        current_step_index: 1,
        created_at: '2026-06-10T00:00:00Z',
        updated_at: '2026-06-10T00:00:00Z',
      },
    } as unknown as Task
    const snap = buildChatTaskSnapshot(task)
    expect(snap.step).toEqual({ index: 1, total: 2, description: '第二步' })
  })
})
