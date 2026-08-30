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
    { call: async () => ({}), callSensitive: async () => ({}) } as never,
    async () => 0,
    'test-secret',
    async (token) => token === 'test-token' ? { sub: 'admin' } : null,
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
    { call: rpcCall, callSensitive: rpcCall } as never,
    async () => 42, // 非零端口，让 dispatchToAgent 正常往下走
    'test-secret',
    async (token) => token === 'test-token' ? { sub: 'admin' } : null,
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
      delivery_id: 'd-text-1',
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
      delivery_id: 'd-sysevent-1',
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
      mgr.handleSendMessage({ session_id: 'admin-chat', delivery_id: 'd-ws-err-1', content: { type: 'text', text: 'ok' } })
    ).resolves.toBeTruthy()
    expect(() =>
      mgr.pushTaskUpdate({ task_id: 't1' as never, status: 'executing' as never, title: 'x' })
    ).not.toThrow()
  })

  it('空文本抛错', async () => {
    const mgr = await makeManager()
    await expect(
      mgr.handleSendMessage({ session_id: 'admin-chat', delivery_id: 'd-empty-1', content: { type: 'text', text: '  ' } })
    ).rejects.toThrow(/Empty message content/)
  })

  it('持久化：新实例 loadData 后可见', async () => {
    const mgr = await makeManager()
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      delivery_id: 'd-persist-1',
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
      delivery_id: 'd-auto-3',
      content: { type: 'text', text: '结构化' },
    })
    expect(mgr.getMessages(10)[0].content.text).toBe('结构化')
    expect(mgr.getMessages(10)[0].content.type).toBe('text')
  })
})

describe('入站带附件消息（handleInboundMessage）', () => {
  it('requires a verified JWT before it can issue an assertion', async () => {
    const mgr = await makeManager()
    await expect(mgr.handleInboundMessage(
      { request_id: 'unauthenticated', text: 'no', files: [] },
      'invalid-token',
    )).rejects.toThrow(/JWT authenticated/)
  })

  it('request_id 路径穿越被拒绝（不落地任何 journal）', async () => {
    const mgr = await makeManager()
    await expect(mgr.handleInboundMessage(
      { request_id: '../escape', text: 'hi', files: [] },
      'test-token',
    )).rejects.toThrow(/invalid request_id/)
    const journalDir = path.join(TEST_DATA_DIR, 'chat-inbound-dispatch-journal')
    await expect(fs.readdir(journalDir)).rejects.toThrow(/ENOENT/)
  })

  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  it('process_message RPC 失败：消息落库、outbox 保持 pending_dispatch 供重试/重启恢复', async () => {
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
    }, 'test-token')
    // user 消息已落库且正常返回
    expect(result.message.content.text).toBe('会失败的消息')
    expect(mgr.getMessages(10)).toHaveLength(1)
    // P6-A §11.4：失败不再立即 chat_error——dispatch loop 退避重试（上限后报错），
    // journal 保持 pending_dispatch；重启由 reconcileInboundDispatches 恢复。
    // 2026-08-30：chat_status 占位推送退役（protocol-admin §3.20.2）——无推送。
    expect(pushed).toEqual([])
    const journalPath = `${TEST_DATA_DIR}/chat-inbound-dispatch-journal/req-err.json`
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf-8'))
    expect(journal.status).toBe('pending_dispatch')
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
    }, 'test-token')
    // 落库消息：URL 形态 media[]
    expect(result.message.content.type).toBe('image')
    expect(result.message.content.text).toBe('看下这两张图')
    expect(result.message.content.media).toHaveLength(2)
    expect(result.message.content.media![0].media_url).toMatch(/^\/api\/media\//)
    // dispatch loop 是异步的：等 process_message 到达
    for (let i = 0; i < 200 && !calls.some((c) => c.method === 'process_message'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
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
    await expect(mgr.handleInboundMessage({ request_id: 'r', text: ' ', files: [] }, 'test-token')).rejects.toThrow()
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
      delivery_id: 'd-auto-4',
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
      delivery_id: 'd-auto-5',
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
      delivery_id: 'd-auto-6',
      content: { type: 'image', media_url: 'https://example.com/x.png', mime_type: 'image/png' },
    })
    expect(mgr.getMessages(10)[0].content.media![0].media_url).toBe('https://example.com/x.png')
  })

  it('收存失败（文件不存在）→ 降级为文本说明，不丢消息', async () => {
    const mgr = await makeManager()
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      delivery_id: 'd-auto-7',
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
      delivery_id: 'd-auto-8',
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
      delivery_id: 'd-auto-9',
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



  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  /** 先注入一条 pending 的入站 request（不经 RPC：直接写 index + message + outbox journal）。 */
  async function seedPendingRequest(mgr: ChatManager, requestId: string): Promise<void> {
    const internal = mgr as unknown as {
      requestIndex: { recordAdmission(input: unknown): Promise<unknown> }
      messages: Map<string, unknown>
      saveData(): Promise<void>
    }
    await internal.requestIndex.load()
    await internal.requestIndex.recordAdmission({
      request_id: requestId,
      session_id: 'admin-chat',
      fingerprint: `fp-${requestId}`,
    })
  }

  it('admin-chat delivery 必须带 delivery_id；缺省抛错且不落库', async () => {
    const mgr = await makeManager()
    await expect(
      mgr.handleSendMessage({ session_id: 'admin-chat', content: { type: 'text', text: 'no id' } })
    ).rejects.toThrow(/delivery_id is required/)
    expect(mgr.getMessages(10)).toHaveLength(0)
  })

  it('带 request_ids 的 delivery：全部 pending 才 commit，并一次性结算', async () => {
    const mgr = await makeManager()
    await seedPendingRequest(mgr, 'req-1')
    await seedPendingRequest(mgr, 'req-2')
    const result = await mgr.handleSendMessage({
      session_id: 'admin-chat',
      delivery_id: 'd-cas-1',
      request_ids: ['req-1', 'req-2'],
      content: { type: 'text', text: '一条回复结算两条' },
    })
    expect(result.platform_message_id).toBeTruthy()
    const stored = mgr.getMessages(10)
    expect(stored[0].request_ids).toEqual(['req-1', 'req-2'])
    expect(stored[0].delivery_id).toBe('d-cas-1')
    const index = (mgr as unknown as { requestIndex: { get(id: string): { status: string } | undefined } }).requestIndex
    expect(index.get('req-1')?.status).toBe('settled')
    expect(index.get('req-2')?.status).toBe('settled')
  })

  it('request_ids 含非 pending ID → 整批拒绝（零 mutation）', async () => {
    const mgr = await makeManager()
    await seedPendingRequest(mgr, 'req-pending')
    await expect(
      mgr.handleSendMessage({
        session_id: 'admin-chat',
        delivery_id: 'd-cas-2',
        request_ids: ['req-pending', 'req-unknown'],
        content: { type: 'text', text: 'x' },
      })
    ).rejects.toThrow(/not pending/)
    expect(mgr.getMessages(10)).toHaveLength(0)
  })

  it('request_ids 数组内重复 → 整批拒绝', async () => {
    const mgr = await makeManager()
    await seedPendingRequest(mgr, 'req-dup')
    await expect(
      mgr.handleSendMessage({
        session_id: 'admin-chat',
        delivery_id: 'd-cas-3',
        request_ids: ['req-dup', 'req-dup'],
        content: { type: 'text', text: 'x' },
      })
    ).rejects.toThrow(/duplicate request_id/)
  })

  it('同 delivery_id 重放：返回首次结果，不重复落库', async () => {
    const mgr = await makeManager()
    const first = await mgr.handleSendMessage({
      session_id: 'admin-chat',
      delivery_id: 'd-replay-1',
      content: { type: 'text', text: '首达' },
    })
    const second = await mgr.handleSendMessage({
      session_id: 'admin-chat',
      delivery_id: 'd-replay-1',
      content: { type: 'text', text: '首达' },
    })
    expect(second.platform_message_id).toBe(first.platform_message_id)
    expect(mgr.getMessages(10)).toHaveLength(1)
  })

  it('同 delivery_id 不同 payload → 冲突拒绝', async () => {
    const mgr = await makeManager()
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      delivery_id: 'd-conflict-1',
      content: { type: 'text', text: '第一版' },
    })
    await expect(
      mgr.handleSendMessage({
        session_id: 'admin-chat',
        delivery_id: 'd-conflict-1',
        content: { type: 'text', text: '改了内容' },
      })
    ).rejects.toThrow(/conflicts/)
    expect(mgr.getMessages(10)).toHaveLength(1)
    expect(mgr.getMessages(10)[0].content.text).toBe('第一版')
  })

  it('proactive push（无 request_ids）独立追加，不消费 pending', async () => {
    const mgr = await makeManager()
    await seedPendingRequest(mgr, 'req-pending-x')
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      delivery_id: 'd-proactive-1',
      content: { type: 'text', text: '主动汇报' },
    })
    const index = (mgr as unknown as { requestIndex: { get(id: string): { status: string } | undefined } }).requestIndex
    expect(index.get('req-pending-x')?.status).toBe('pending')
    expect(mgr.getMessages(10)[0].request_ids).toBeUndefined()
  })

  it('chat_callback 已退役：只返回 retired 错误，不写消息', async () => {
    const mgr = await makeManager()
    await expect(
      mgr.handleChatCallback({ request_id: 'r', reply_type: 'direct_reply', content: 'x' } as never)
    ).rejects.toThrow(/retired/)
    expect(mgr.getMessages(10)).toHaveLength(0)
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
      delivery_id: 'd-auto-21',
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
      delivery_id: 'd-auto-22',
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

describe('ChatManager.chat_acknowledge（protocol-admin §3.20.2）', () => {
  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  /** 落一条 user 消息并挂上可观察的 ws 客户端 */
  async function makeManagerWithUserMessage(requestId: string): Promise<ChatManager> {
    const mgr = await makeManager()
    await mgr.handleInboundMessage({ request_id: requestId, text: '在吗', files: [] }, 'test-token')
    const pushed: Array<Record<string, unknown>> = []
    ;(mgr as unknown as { activeClient: unknown }).activeClient = {
      readyState: 1, // WebSocket.OPEN
      send: (data: string) => { pushed.push(JSON.parse(data)) },
    }
    ;(mgr as unknown as { testPushed?: Array<Record<string, unknown>> }).testPushed = pushed
    return mgr
  }

  function pushedOf(mgr: ChatManager): Array<Record<string, unknown>> {
    return (mgr as unknown as { testPushed?: Array<Record<string, unknown>> }).testPushed ?? []
  }

  it('打标：写 acknowledged_at、推 chat_message_acked、返回 1；重载后标记仍在（持久化）', async () => {
    const mgr = await makeManagerWithUserMessage('req-ack-1')
    expect(await mgr.acknowledgeRequests(['req-ack-1'])).toBe(1)

    const user = mgr.getMessages(10).find((m) => m.role === 'user')
    expect(user?.acknowledged_at).toBeTruthy()
    expect(pushedOf(mgr).map((p) => p.type)).toEqual(['chat_message_acked'])
    expect(pushedOf(mgr)[0].request_ids).toEqual(['req-ack-1'])

    const mgr2 = await makeManager()
    await mgr2.loadData()
    expect(mgr2.getMessages(10).find((m) => m.role === 'user')?.acknowledged_at).toBeTruthy()
  })

  it('幂等：重复调用返回 0，不重复推送', async () => {
    const mgr = await makeManagerWithUserMessage('req-ack-2')
    expect(await mgr.acknowledgeRequests(['req-ack-2'])).toBe(1)
    expect(await mgr.acknowledgeRequests(['req-ack-2'])).toBe(0)
    expect(pushedOf(mgr)).toHaveLength(1)
  })

  it('未知 request_id 静默忽略，返回 0', async () => {
    const mgr = await makeManager()
    expect(await mgr.acknowledgeRequests(['nope'])).toBe(0)
  })
})
