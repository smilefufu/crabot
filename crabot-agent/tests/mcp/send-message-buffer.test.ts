/**
 * send_message goal-mode 缓冲分支测试
 * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.1 + §4.6 (Task 6)
 *
 * | 状态                | send_message(intent='info') 行为     |
 * |--------------------|------------------------------------|
 * | 工作态（goal + 无 audit） | 进 outboundBuffer，不发              |
 * | 等审态（goal + audit 在跑） | 立即 flush（过程响应不缓冲）           |
 * | 非 goal mode        | 立即发                              |
 * | ask_human          | 立即发（barrier 路径）                |
 */

import { describe, it, expect, vi } from 'vitest'
import { buildMessagingTools } from '../../src/mcp/crab-messaging.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import type { OutboundBufferEntry } from '../../src/agent/outbound-flush.js'

function findTool(tools: ReturnType<typeof buildMessagingTools>, name: string) {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

// 复用 src 真实类型，避免三处重复定义漂移（reviewer Task 5 minor #1）
type BufferEntry = OutboundBufferEntry

describe('send_message buffering (goal mode)', () => {
  it('non-goal-mode task: 立即发到 channel（不进 buffer）', async () => {
    const queue = new HumanMessageQueue()
    const buffer: BufferEntry[] = []
    const rpcMethods: string[] = []

    const tools = buildMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port: number, method: string) => {
          rpcMethods.push(method)
          if (method === 'send_message') return { platform_message_id: 'm1', sent_at: '2026-06-07T00:00:00Z' }
          return {}
        }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: queue,
        triggerType: 'message' as const,
        hasGoal: () => false, // ← 非 goal mode
        outboundBuffer: buffer,
        hasActiveAudit: () => false,
      }),
    })

    const sendTool = findTool(tools, 'send_message')
    const result = await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: 'hello',
    })

    // sendMessage 被调
    expect(rpcMethods).toContain('send_message')
    // buffer 不变
    expect(buffer).toHaveLength(0)
    // 返回真实 sent_at（非缓冲标记）
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const parsed = JSON.parse(text)
    expect(parsed.buffered).toBeUndefined()
    expect(parsed.platform_message_id).toBe('m1')
  })

  it('goal-mode 工作态: 缓冲 info 不调 channel', async () => {
    const queue = new HumanMessageQueue()
    const buffer: BufferEntry[] = []
    const rpcMethods: string[] = []

    const tools = buildMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port: number, method: string) => {
          rpcMethods.push(method)
          return {}
        }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: queue,
        triggerType: 'message' as const,
        hasGoal: () => true, // ← goal mode
        outboundBuffer: buffer,
        hasActiveAudit: () => false, // ← 工作态
        getHumanInputEpoch: () => 7,
      }),
    })

    const sendTool = findTool(tools, 'send_message')
    const result = await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: '正在干活',
    })

    // sendMessage 未被调
    expect(rpcMethods).not.toContain('send_message')
    // buffer +1
    expect(buffer).toHaveLength(1)
    expect(buffer[0]).toMatchObject({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: '正在干活',
      intent: 'info',
      human_input_epoch: 7,
    })
    expect(buffer[0].sent_at_attempt_ms).toBeGreaterThan(0)

    // 输出含 "buffered":true（Task 7 query-loop 依赖此字符串）
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain('"buffered":true')
    const parsed = JSON.parse(text)
    expect(parsed.buffered).toBe(true)
    expect(parsed.sent_at).toBeNull()
  })

  it('goal-mode + ask_human: NOT 缓冲（走 barrier 路径，立即发）', async () => {
    const queue = new HumanMessageQueue()
    const buffer: BufferEntry[] = []
    const rpcMethods: string[] = []

    const tools = buildMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port: number, method: string) => {
          rpcMethods.push(method)
          if (method === 'send_message') return { platform_message_id: 'm1', sent_at: '2026-06-07T00:00:00Z' }
          if (method === 'update_task_status') return { task: { id: 't1', status: 'waiting_human' } }
          return {}
        }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: queue,
        triggerType: 'message' as const,
        hasGoal: () => true, // ← goal mode
        outboundBuffer: buffer,
        hasActiveAudit: () => false, // ← 工作态
      }),
    })

    const sendTool = findTool(tools, 'send_message')
    await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: '你倾向 A 还是 B？',
      intent: 'ask_human', // ← 关键
    })

    // sendMessage 被调（ask_human 不进 buffer）
    expect(rpcMethods).toContain('send_message')
    // buffer 不变
    expect(buffer).toHaveLength(0)
    // barrier 被设
    expect(queue.hasBarrier).toBe(true)
    queue.clearBarrier()
  })

  it('goal-mode 等审态: 立即 flush info（不缓冲，过程响应）', async () => {
    const queue = new HumanMessageQueue()
    const buffer: BufferEntry[] = []
    const rpcMethods: string[] = []

    const tools = buildMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port: number, method: string) => {
          rpcMethods.push(method)
          if (method === 'send_message') return { platform_message_id: 'm1', sent_at: '2026-06-07T00:00:00Z' }
          return {}
        }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: queue,
        triggerType: 'message' as const,
        hasGoal: () => true, // ← goal mode
        outboundBuffer: buffer,
        hasActiveAudit: () => true, // ← 等审态
      }),
    })

    const sendTool = findTool(tools, 'send_message')
    const result = await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: '进度告知：还在跑',
    })

    // 立即发，sendMessage 被调
    expect(rpcMethods).toContain('send_message')
    // buffer 不变（不进新缓冲）
    expect(buffer).toHaveLength(0)
    // 返回真实结果
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const parsed = JSON.parse(text)
    expect(parsed.buffered).toBeUndefined()
    expect(parsed.platform_message_id).toBe('m1')
  })

  it('缓冲 entry 含所有 send_message 参数（content_type / media_url / mentions / quote_message_id / etc.）', async () => {
    const queue = new HumanMessageQueue()
    const buffer: BufferEntry[] = []

    const tools = buildMessagingTools({
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: queue,
        triggerType: 'message' as const,
        hasGoal: () => true,
        outboundBuffer: buffer,
        hasActiveAudit: () => false,
      }),
    })

    const sendTool = findTool(tools, 'send_message')
    await sendTool.handler({
      channel_id: 'feishu-001',
      session_id: 'session-x',
      content: '看这个图',
      intent: 'info',
      content_type: 'image',
      media_url: 'https://example.com/img.png',
      filename: 'report.png',
      mentions: [
        { friend_id: 'f-master', at_name: '@老板' },
        { platform_user_id: 'ou_abc', at_name: '@同事' },
      ],
      quote_message_id: 'platform-msg-99',
    })

    expect(buffer).toHaveLength(1)
    const entry = buffer[0]
    expect(entry.channel_id).toBe('feishu-001')
    expect(entry.session_id).toBe('session-x')
    expect(entry.content).toBe('看这个图')
    expect(entry.intent).toBe('info')
    expect(entry.content_type).toBe('image')
    expect(entry.media_url).toBe('https://example.com/img.png')
    expect(entry.filename).toBe('report.png')
    expect(entry.mentions).toEqual([
      { friend_id: 'f-master', at_name: '@老板' },
      { platform_user_id: 'ou_abc', at_name: '@同事' },
    ])
    expect(entry.quote_message_id).toBe('platform-msg-99')
    // 不传的字段应不存在
    expect(entry.file_path).toBeUndefined()
  })

  it('TaskContext 缺 outboundBuffer / hasActiveAudit（旧调用方）: 不缓冲，立即发（向后兼容）', async () => {
    const queue = new HumanMessageQueue()
    const rpcMethods: string[] = []

    const tools = buildMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port: number, method: string) => {
          rpcMethods.push(method)
          if (method === 'send_message') return { platform_message_id: 'm1', sent_at: '' }
          return {}
        }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      // 旧调用方：hasGoal=true 但没传 outboundBuffer / hasActiveAudit
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: queue,
        triggerType: 'message' as const,
        hasGoal: () => true,
        // outboundBuffer / hasActiveAudit 未传
      }),
    })

    const sendTool = findTool(tools, 'send_message')
    await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: 'hi',
    })

    // 缺少缓冲 deps → 走立即发路径
    expect(rpcMethods).toContain('send_message')
  })

  it('相对 file_path + 本地无沙盒映射 → 用 getCwd 就地解析成绝对路径再缓冲（B: 工具自愈，trace a72623ec）', async () => {
    const queue = new HumanMessageQueue()
    const buffer: BufferEntry[] = []

    const tools = buildMessagingTools({
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: queue,
        triggerType: 'message' as const,
        hasGoal: () => true,
        outboundBuffer: buffer,
        hasActiveAudit: () => false,
        getCwd: () => '/Users/fufu/codes/playground/quant-signal',
      }),
    }) // 第二参 sandboxPathMappingsRef 不传 = 本地无映射

    const sendTool = findTool(tools, 'send_message')
    await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 'sess',
      content: '改成 HTML 了',
      intent: 'info',
      content_type: 'file',
      file_path: 'reports/research/viz.html', // ← 相对路径（旧版会拖到 flush 才抛错、失败被吞）
    })

    expect(buffer).toHaveLength(1)
    // 相对路径已基于 cwd 解析成绝对路径，不会再在延迟 flush 阶段抛错
    expect(buffer[0].file_path).toBe(
      '/Users/fufu/codes/playground/quant-signal/reports/research/viz.html',
    )
  })

  it('绝对 file_path → 保持不变（不被 cwd 二次拼接）', async () => {
    const queue = new HumanMessageQueue()
    const buffer: BufferEntry[] = []

    const tools = buildMessagingTools({
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: queue,
        triggerType: 'message' as const,
        hasGoal: () => true,
        outboundBuffer: buffer,
        hasActiveAudit: () => false,
        getCwd: () => '/some/cwd',
      }),
    })

    const sendTool = findTool(tools, 'send_message')
    await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 'sess',
      content: 'x',
      intent: 'info',
      content_type: 'file',
      file_path: '/abs/path/viz.html',
    })

    expect(buffer).toHaveLength(1)
    expect(buffer[0].file_path).toBe('/abs/path/viz.html')
  })
})
