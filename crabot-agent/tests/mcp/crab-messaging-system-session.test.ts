import { describe, it, expect, vi } from 'vitest'
import { buildWorkerMessagingTools } from '../../src/mcp/crab-messaging.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'

function findTool(tools: ReturnType<typeof buildWorkerMessagingTools>, name: string) {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

describe('send_message rejects SYSTEM_SESSION sentinel', () => {
  it('returns error when channel_id is the system sentinel', async () => {
    const callMock = vi.fn()
    const tools = buildWorkerMessagingTools({
      rpcClient: { call: callMock } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: new HumanMessageQueue(),
        triggerType: 'scheduled' as const,
        hasGoal: () => false,
      }),
    })

    const sendTool = findTool(tools, 'send_message')
    const result = await sendTool.handler({
      channel_id: 'system',
      session_id: 'sess-real',
      content: 'should be rejected',
    })

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const parsed = JSON.parse(text)
    expect(parsed.error).toContain('系统占位符')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('returns error when session_id is the system sentinel', async () => {
    const callMock = vi.fn()
    const tools = buildWorkerMessagingTools({
      rpcClient: { call: callMock } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: new HumanMessageQueue(),
        triggerType: 'scheduled' as const,
        hasGoal: () => false,
      }),
    })

    const sendTool = findTool(tools, 'send_message')
    const result = await sendTool.handler({
      channel_id: 'wechat-real',
      session_id: 'system',
      content: 'should be rejected',
    })

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const parsed = JSON.parse(text)
    expect(parsed.error).toContain('系统占位符')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('passes through when both channel_id and session_id are real', async () => {
    const callMock = vi.fn().mockResolvedValue({ platform_message_id: 'm1', sent_at: '2026-06-05T00:00:00Z' })
    const tools = buildWorkerMessagingTools({
      rpcClient: { call: callMock } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: new HumanMessageQueue(),
        triggerType: 'message' as const,
        hasGoal: () => false,
      }),
    })

    const sendTool = findTool(tools, 'send_message')
    const result = await sendTool.handler({
      channel_id: 'wechat-real',
      session_id: 'sess-real',
      content: 'real send',
    })

    expect(callMock).toHaveBeenCalled()
    expect(result.observedSessionTargets).toEqual([
      { channel_id: 'wechat-real', session_id: 'sess-real' },
    ])
    expect(JSON.parse(result.content[0].text)).not.toHaveProperty('observedSessionTargets')
  })

  it('marks a channel delivery failure as a tool error', async () => {
    const callMock = vi.fn().mockRejectedValue(new Error('channel offline'))
    const tools = buildWorkerMessagingTools({
      rpcClient: { call: callMock } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: new HumanMessageQueue(),
        triggerType: 'message' as const,
        hasGoal: () => false,
      }),
    })

    const result = await findTool(tools, 'send_message').handler({
      channel_id: 'wechat-real',
      session_id: 'sess-real',
      content: 'should fail',
    })

    expect(result.isError).toBe(true)
    expect(result.observedSessionTargets).toBeUndefined()
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: '发送失败: channel offline' })
  })
})
