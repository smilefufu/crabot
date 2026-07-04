/**
 * AgentHandler.runGoalAudit 单元测试。
 *
 * 覆盖：
 *  - pass 路径：调 complete_task_goal + 写 audit_history + 返回 pass=true
 *  - fail 路径：不调 complete_task_goal + 返回 pass=false + detailedReport 含未达成 criterion
 *  - traceSummaryPrefix='[goal_audit]' / traceTaskType='goal_audit' 透传到 runSubAgentDirect（M4）
 *  - task 没 goal → 抛 has no goal
 *  - subAgents 里没 goal_auditor → 抛 not configured
 *
 * 实现策略：覆盖私有 runSubAgentDirect（method 级 mock，不走 forkEngine / trace store 真实路径），
 * deps 只塞 rpcClient + getAdminPort + moduleId 三件套。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import type { SubAgentConfig } from '../../src/types.js'
import type { GoalAuditTaskGoal, ParsedAuditReport } from '../../src/agent/goal-audit.js'

function sampleGoal(): GoalAuditTaskGoal {
  return {
    objective: '实现功能 X',
    acceptance_criteria: [
      { id: 'c1', kind: 'cmd', spec: 'pnpm typecheck', expect: { exit_code: 0 } },
    ],
  }
}

function makeAuditorConfig(): SubAgentConfig {
  return {
    id: 'builtin-goal-auditor',
    name: 'goal_auditor',
    description: 'Goal auditor',
    when_to_use: '内部触发',
    role: 'auditor',
    workflow: 'verify',
    deliverables: 'AUDIT_REPORT',
    model: {
      endpoint: 'http://localhost:4000',
      apikey: 'test-key',
      model_id: 'test-model',
      format: 'anthropic',
    },
    builtin_capabilities: {
      file_system: true,
      shell: true,
      task_intel: false,
      crab_memory: false,
      crab_messaging: false,
    },
    allowed_mcp_server_ids: [],
    allowed_skill_ids: [],
    max_turns: 10,
    system_only: true,
  }
}

function makeHandler(opts: {
  rpcCall: ReturnType<typeof vi.fn>
  runSubAgentDirect?: ReturnType<typeof vi.fn>
  subAgents?: SubAgentConfig[]
}): AgentHandler {
  const sdkEnv = {
    modelId: 'test-model',
    format: 'anthropic' as const,
    env: {
      ANTHROPIC_BASE_URL: 'http://localhost:4000',
      ANTHROPIC_API_KEY: 'test-key',
    },
  }
  const handler = new AgentHandler(
    sdkEnv,
    { systemPrompt: 'worker' },
    {
      deps: {
        rpcClient: { call: opts.rpcCall } as unknown as import('crabot-shared').RpcClient,
        moduleId: 'agent-test',
        resolveChannelPort: async () => 3003,
        getMemoryPort: async () => 3002,
        getAdminPort: async () => 19000,
      },
      subAgents: opts.subAgents ?? [makeAuditorConfig()],
    },
  )
  if (opts.runSubAgentDirect) {
    // 覆盖私有 method —— runGoalAudit 内部走 this.runSubAgentDirect
    ;(handler as unknown as { runSubAgentDirect: typeof opts.runSubAgentDirect }).runSubAgentDirect =
      opts.runSubAgentDirect
  }
  return handler
}

describe('AgentHandler.runGoalAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('audit pass → 调 append_task_goal_audit_entry + complete_task_goal + 返回 pass=true', async () => {
    const rpcCall = vi.fn()
      .mockResolvedValueOnce({ task: { id: 't1', goal: sampleGoal() } }) // get_task
      .mockResolvedValueOnce({}) // append_task_goal_audit_entry
      .mockResolvedValueOnce({}) // complete_task_goal
    const runSubAgentDirect = vi.fn().mockResolvedValue({
      output: 'AUDIT_RESULT: pass\nFAILED_CRITERIA: []\n\nAUDIT_REPORT_END',
      isError: false,
      traceId: 'trace-abc',
    })
    const handler = makeHandler({ rpcCall, runSubAgentDirect })
    try {
      const result = await handler.runGoalAudit({ taskId: 't1', conversationLog: [{ role: 'agent', intent: 'info', content: '做完了' }] })
      expect(result.pass).toBe(true)
      expect(result.failedCriteria).toEqual([])
      expect(result.auditTraceId).toBe('trace-abc')

      // RPC 调用顺序验证
      expect(rpcCall).toHaveBeenCalledTimes(3)
      expect(rpcCall.mock.calls[0][1]).toBe('get_task')
      expect(rpcCall.mock.calls[1][1]).toBe('append_task_goal_audit_entry')
      expect(rpcCall.mock.calls[2][1]).toBe('complete_task_goal')

      // append_task_goal_audit_entry 内容
      expect(rpcCall.mock.calls[1][2]).toMatchObject({
        task_id: 't1',
        entry: expect.objectContaining({
          pass: true,
          failed_criteria: [],
          audit_trace_id: 'trace-abc',
        }),
      })

      // complete_task_goal payload
      expect(rpcCall.mock.calls[2][2]).toEqual({ task_id: 't1' })
    } finally {
      handler.dispose()
    }
  })

  it('audit fail → 不调 complete_task_goal + 返回 pass=false + detailedReport 含未达成 criterion', async () => {
    const rpcCall = vi.fn()
      .mockResolvedValueOnce({ task: { id: 't2', goal: sampleGoal() } }) // get_task
      .mockResolvedValueOnce({}) // append_task_goal_audit_entry
    const runSubAgentDirect = vi.fn().mockResolvedValue({
      output: 'AUDIT_RESULT: fail\nFAILED_CRITERIA: [c1]\n\n## 失败原因\n- typecheck 报错\n\nAUDIT_REPORT_END',
      isError: false,
      traceId: 'trace-xyz',
    })
    const handler = makeHandler({ rpcCall, runSubAgentDirect })
    try {
      const result = await handler.runGoalAudit({ taskId: 't2', conversationLog: [{ role: 'agent', intent: 'info', content: '做完了' }] })
      expect(result.pass).toBe(false)
      expect(result.failedCriteria).toEqual(['c1'])
      expect(result.auditTraceId).toBe('trace-xyz')
      // detailedReport 包含 fail 报告核心要素（"日记体" 改造：仅你可见标记 + 自检反馈语义）
      expect(result.detailedReport).toContain('仅你可见')
      expect(result.detailedReport).toMatch(/自检.*差距|还没满足的承诺项/)
      expect(result.detailedReport).toContain('c1')
      expect(result.detailedReport).toContain('typecheck 报错')

      // 不调 complete_task_goal —— 只有两次 RPC
      expect(rpcCall).toHaveBeenCalledTimes(2)
      expect(rpcCall.mock.calls[0][1]).toBe('get_task')
      expect(rpcCall.mock.calls[1][1]).toBe('append_task_goal_audit_entry')
      const completeCalls = rpcCall.mock.calls.filter((c) => c[1] === 'complete_task_goal')
      expect(completeCalls).toHaveLength(0)

      // audit_history entry 记 fail
      expect(rpcCall.mock.calls[1][2]).toMatchObject({
        task_id: 't2',
        entry: expect.objectContaining({
          pass: false,
          failed_criteria: ['c1'],
        }),
      })
    } finally {
      handler.dispose()
    }
  })

  it('append 返回 goal 已 blocked → 透出 goalStatus=blocked + blockedGuidance', async () => {
    const rpcCall = vi.fn()
      .mockResolvedValueOnce({ task: { id: 't3', goal: sampleGoal() } }) // get_task
      .mockResolvedValueOnce({ task: { id: 't3', goal: { ...sampleGoal(), status: 'blocked' } } }) // append → 已 blocked
    const runSubAgentDirect = vi.fn().mockResolvedValue({
      output: 'AUDIT_RESULT: fail\nFAILED_CRITERIA: [c1]\n\nAUDIT_REPORT_END',
      isError: false,
      traceId: 'trace-blk',
    })
    const handler = makeHandler({ rpcCall, runSubAgentDirect })
    try {
      const result = await handler.runGoalAudit({ taskId: 't3', conversationLog: [{ role: 'agent', intent: 'info', content: 'x' }] })
      expect(result.pass).toBe(false)
      expect(result.goalStatus).toBe('blocked')
      expect(result.blockedGuidance).toContain('仅你可见')
    } finally {
      handler.dispose()
    }
  })

  it('append 返回仍 active → goalStatus=active 且无 blockedGuidance', async () => {
    const rpcCall = vi.fn()
      .mockResolvedValueOnce({ task: { id: 't4', goal: sampleGoal() } })
      .mockResolvedValueOnce({ task: { id: 't4', goal: { ...sampleGoal(), status: 'active' } } })
    const runSubAgentDirect = vi.fn().mockResolvedValue({
      output: 'AUDIT_RESULT: fail\nFAILED_CRITERIA: [c1]\n\nAUDIT_REPORT_END',
      isError: false,
      traceId: 'trace-act',
    })
    const handler = makeHandler({ rpcCall, runSubAgentDirect })
    try {
      const result = await handler.runGoalAudit({ taskId: 't4', conversationLog: [{ role: 'agent', intent: 'info', content: 'x' }] })
      expect(result.goalStatus).toBe('active')
      expect(result.blockedGuidance).toBeUndefined()
    } finally {
      handler.dispose()
    }
  })

  it('runSubAgentDirect 收到 traceSummaryPrefix="[goal_audit]" 和 traceTaskType="goal_audit"（M4）', async () => {
    const rpcCall = vi.fn()
      .mockResolvedValueOnce({ task: { id: 't', goal: sampleGoal() } })
      .mockResolvedValue({})
    const runSubAgentDirect = vi.fn().mockResolvedValue({
      output: 'AUDIT_RESULT: pass\nFAILED_CRITERIA: []',
      isError: false,
      traceId: 'tr-1',
    })
    const handler = makeHandler({ rpcCall, runSubAgentDirect })
    try {
      await handler.runGoalAudit({ taskId: 't', conversationLog: [{ role: 'agent', intent: 'info', content: 'x' }] })
      expect(runSubAgentDirect).toHaveBeenCalledTimes(1)
      const callArgs = runSubAgentDirect.mock.calls[0]
      // callArgs[3] 是 deps 参数
      expect(callArgs[3]).toMatchObject({
        traceSummaryPrefix: '[goal_audit]',
        traceTaskType: 'goal_audit',
        callerLabel: 'goal_audit',
        parentTaskId: 't',
        parentTools: [],
      })
      // input 段必须把 subagent_type='goal_auditor' + 拼好的 prompt 一起塞进去
      expect(callArgs[1]).toMatchObject({
        subagent_type: 'goal_auditor',
      })
      expect(String(callArgs[1].task)).toContain('实现功能 X')
    } finally {
      handler.dispose()
    }
  })

  it('task 没 goal → 抛错且不调任何后续 RPC', async () => {
    const rpcCall = vi.fn()
      .mockResolvedValueOnce({ task: { id: 't', /* no goal */ } })
    const runSubAgentDirect = vi.fn()
    const handler = makeHandler({ rpcCall, runSubAgentDirect })
    try {
      await expect(
        handler.runGoalAudit({ taskId: 't', conversationLog: [{ role: 'agent', intent: 'info', content: 'x' }] }),
      ).rejects.toThrow(/has no goal/)
      expect(runSubAgentDirect).not.toHaveBeenCalled()
      // 只调了一次 get_task
      expect(rpcCall).toHaveBeenCalledTimes(1)
    } finally {
      handler.dispose()
    }
  })

  it('subAgents 里没 goal_auditor → 抛 not configured', async () => {
    const rpcCall = vi.fn()
      .mockResolvedValueOnce({ task: { id: 't', goal: sampleGoal() } })
    const runSubAgentDirect = vi.fn()
    const handler = makeHandler({ rpcCall, runSubAgentDirect, subAgents: [] })
    try {
      await expect(
        handler.runGoalAudit({ taskId: 't', conversationLog: [{ role: 'agent', intent: 'info', content: 'x' }] }),
      ).rejects.toThrow(/goal_auditor.*not configured/)
      expect(runSubAgentDirect).not.toHaveBeenCalled()
    } finally {
      handler.dispose()
    }
  })
})

describe('AgentHandler.persistAsyncAuditResult', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('async audit pass → 写 audit_history、complete goal、patch audit trace outcome', async () => {
    const rpcCall = vi.fn()
      .mockResolvedValueOnce({ task: { id: 't-async', goal: { ...sampleGoal(), status: 'active' } } })
      .mockResolvedValueOnce({ task: { id: 't-async', goal: { ...sampleGoal(), status: 'complete' } } })
    const appendTraceOutcome = vi.fn()
    const handler = makeHandler({ rpcCall })
    try {
      await (handler as any).persistAsyncAuditResult({
        taskId: 't-async',
        auditId: 'audit-trace-1',
        parsed: {
          pass: true,
          failedCriteria: [],
          rawOutput: 'ok',
        } satisfies ParsedAuditReport,
        verdictSummary: { summary: '[audit PASS]' },
        traceStore: { appendTraceOutcome },
      })

      expect(rpcCall).toHaveBeenCalledTimes(2)
      expect(rpcCall.mock.calls[0][1]).toBe('append_task_goal_audit_entry')
      expect(rpcCall.mock.calls[0][2]).toMatchObject({
        task_id: 't-async',
        entry: expect.objectContaining({
          pass: true,
          failed_criteria: [],
          audit_trace_id: 'audit-trace-1',
        }),
      })
      expect(rpcCall.mock.calls[1][1]).toBe('complete_task_goal')
      expect(rpcCall.mock.calls[1][2]).toEqual({ task_id: 't-async' })
      expect(appendTraceOutcome).toHaveBeenCalledWith('audit-trace-1', { summary: '[audit PASS]' })
    } finally {
      handler.dispose()
    }
  })

  it('async audit fail → 写 audit_history、不中断 complete，并 patch fail verdict', async () => {
    const rpcCall = vi.fn()
      .mockResolvedValueOnce({ task: { id: 't-async', goal: { ...sampleGoal(), status: 'active' } } })
    const appendTraceOutcome = vi.fn()
    const handler = makeHandler({ rpcCall })
    try {
      await (handler as any).persistAsyncAuditResult({
        taskId: 't-async',
        auditId: 'audit-trace-2',
        parsed: {
          pass: false,
          failedCriteria: ['c1'],
          rawOutput: 'missing c1',
        } satisfies ParsedAuditReport,
        verdictSummary: { summary: '[audit FAIL] 不达标: c1', error: '不达标: c1' },
        traceStore: { appendTraceOutcome },
      })

      expect(rpcCall).toHaveBeenCalledTimes(1)
      expect(rpcCall.mock.calls[0][1]).toBe('append_task_goal_audit_entry')
      expect(rpcCall.mock.calls[0][2]).toMatchObject({
        task_id: 't-async',
        entry: expect.objectContaining({
          pass: false,
          failed_criteria: ['c1'],
          audit_trace_id: 'audit-trace-2',
        }),
      })
      expect(rpcCall.mock.calls.some((c) => c[1] === 'complete_task_goal')).toBe(false)
      expect(appendTraceOutcome).toHaveBeenCalledWith('audit-trace-2', {
        summary: '[audit FAIL] 不达标: c1',
        error: '不达标: c1',
      })
    } finally {
      handler.dispose()
    }
  })
})
