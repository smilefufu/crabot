import { describe, it, expect, vi } from 'vitest'
import { DecisionDispatcher } from '../../src/orchestration/decision-dispatcher.js'

describe('Feedback signal e2e: user_attitude → memory RPC', () => {
  it('reply with user_attitude=pass → memory.report_task_feedback with proper task_id', async () => {
    // 用 Spy 捕获最终 RPC payload
    const rpcCalls: Array<{ method: string; params: any }> = []
    const recentFinish = new Date(Date.now() - 3 * 60 * 1000).toISOString()
    const rpcClient = {
      call: vi.fn(async (_port: number, method: string, params: any) => {
        rpcCalls.push({ method, params })
        if (method === 'list_tasks') {
          return {
            items: [{
              id: 't_xyz',
              status: 'completed',
              finished_at: recentFinish,
              source: { channel_id: 'wechat-1', friend_id: 'fri_zhang' },
            }],
          }
        }
        return {}
      }),
    } as any
    const memoryWriter = {
      reportTaskFeedback: vi.fn(async (taskId: string, attitude: string) => {
        rpcCalls.push({ method: 'memoryWriter.reportTaskFeedback', params: { taskId, attitude } })
      }),
      listRecentLessons: vi.fn(async () => []),
      markValidationOutcome: vi.fn(),
      writeTaskCreated: vi.fn(),
      writeTaskFinished: vi.fn(),
      writeTriageDecision: vi.fn(),
    } as any
    const contextAssembler = {} as any
    const dispatcher = new DecisionDispatcher(
      rpcClient,
      'agent-test',
      contextAssembler,
      memoryWriter,
      async () => 19001,
      async (_channelId: string) => 19010,
    )

    await dispatcher.dispatch(
      {
        type: 'direct_reply',
        reply: { type: 'text', text: '不客气~' },
        user_attitude: 'pass',
      },
      {
        channel_id: 'wechat-1',
        session_id: 'sess_1',
        messages: [],
        senderFriend: { id: 'fri_zhang', display_name: '张三' } as any,
        memoryPermissions: {} as any,
      },
    )

    // 等一拍，让 fire-and-forget 完成
    await new Promise(resolve => setTimeout(resolve, 50))

    const feedbackCall = rpcCalls.find(c => c.method === 'memoryWriter.reportTaskFeedback')
    expect(feedbackCall).toBeDefined()
    expect(feedbackCall?.params).toEqual({ taskId: 't_xyz', attitude: 'pass' })
  })
})
