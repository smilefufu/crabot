/**
 * Tests for spawnAuditSubagent (audit-spawn.ts)
 *
 * spawnPersistentAgent 通过 spawnFn 依赖注入 mock，掌控 onExit 触发时序。
 * 不跑真 runEngine —— 单元测试只关心 audit-spawn 自身的 marker 构造 / push 行为。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  spawnAuditSubagent,
  resolveAuditJudgmentFromExitInfo,
  type BgAgentExitInfo,
  type SpawnAuditSubagentDeps,
} from '../../src/agent/audit-spawn'
import { HumanMessageQueue } from '../../src/engine/human-message-queue'
import {
  AUDIT_PARSE_FAILURE_SENTINEL,
  type GoalAuditTaskGoal,
} from '../../src/agent/goal-audit'
import { parseSystemMarker } from '../../src/agent/audit-result-marker'
import type { SubAgentConfig } from '../../src/types'
import type { LLMAdapter } from '../../src/engine/llm-adapter'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeGoal(): GoalAuditTaskGoal {
  return {
    objective: '修好 audit 异步化',
    acceptance_criteria: [
      { id: 'c-1', kind: 'semantic', spec: 'audit 不阻塞 main loop', rationale: '主循环不卡 10-30s' },
      { id: 'c-2', kind: 'cmd', spec: 'tests pass', rationale: 'vitest 全过' },
    ],
  }
}

function makeAuditor(): SubAgentConfig {
  return {
    id: 'builtin-goal-auditor',
    name: 'goal_auditor',
    description: 'Audits whether a task goal is met',
    when_to_use: 'system_only',
    role: 'auditor',
    workflow: 'verify each criterion',
    deliverables: 'submit_audit_result',
    model: {
      endpoint: 'https://example.test',
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
    max_turns: 8,
    system_only: true,
  }
}

function makeAdapter(): LLMAdapter {
  return {
    async *stream() {
      // 不会被调用：spawnFn 是 mock。
    },
    updateConfig() {},
  } as unknown as LLMAdapter
}

function makeDeps(
  overrides: Partial<SpawnAuditSubagentDeps> = {},
): SpawnAuditSubagentDeps & {
  capturedOnExit: { current?: (info: BgAgentExitInfo) => void | Promise<void> }
} {
  const capturedOnExit: { current?: (info: BgAgentExitInfo) => void | Promise<void> } = {}
  const humanQueue = overrides.humanQueue ?? new HumanMessageQueue()
  const spawnFn = (overrides.spawnFn ?? vi.fn(async (opts: any) => {
    // 抓 onExit 回调供测试触发
    capturedOnExit.current = opts.onExit
    return 'agent_test1234'
  })) as SpawnAuditSubagentDeps['spawnFn']

  return {
    goal: overrides.goal ?? makeGoal(),
    conversationLog: overrides.conversationLog ?? [
      { role: 'human', content: 'help me with X' },
      { role: 'agent', content: 'done', intent: 'info' },
    ],
    cwd: overrides.cwd ?? '/tmp/workspace',
    parentTaskId: overrides.parentTaskId ?? 'task-parent-1',
    auditor: overrides.auditor ?? makeAuditor(),
    parentTools: overrides.parentTools ?? [],
    adapter: overrides.adapter ?? makeAdapter(),
    owner: overrides.owner ?? { friend_id: 'friend-1', session_id: 'ses-1' },
    registry: overrides.registry ?? ({} as any),
    abortControllers: overrides.abortControllers ?? new Map(),
    humanQueue,
    ...(overrides.onAuditResult ? { onAuditResult: overrides.onAuditResult } : {}),
    ...(overrides.traceContext ? { traceContext: overrides.traceContext } : {}),
    spawnFn,
    capturedOnExit,
  }
}

function exitInfo(overrides: Partial<BgAgentExitInfo> = {}): BgAgentExitInfo {
  return {
    entity_id: 'agent_test1234',
    task_description: '[goal_audit] xxx',
    status: 'completed',
    exit_code: 0,
    runtime_ms: 1234,
    spawned_at: new Date().toISOString(),
    result_file: '/tmp/agent.result.txt',
    trace_id: 'trace-child-default',
    outcome: 'completed',
    finalText: '',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('spawnAuditSubagent', () => {
  let deps: ReturnType<typeof makeDeps>
  let humanQueue: HumanMessageQueue
  let pushSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    humanQueue = new HumanMessageQueue()
    pushSpy = vi.spyOn(humanQueue, 'push')
    deps = makeDeps({ humanQueue })
  })

  it('returns audit_id immediately without blocking on audit completion', async () => {
    // spawnFn 默认实现立即 return id，不调 onExit —— 模拟 audit 仍在跑
    const startedAt = Date.now()
    const id = await spawnAuditSubagent(deps)
    expect(Date.now() - startedAt).toBeLessThan(100)
    expect(id).toBe('agent_test1234')
    expect(deps.spawnFn).toHaveBeenCalledOnce()
    // 重要：audit 还没完成，humanQueue 不该有任何 push
    expect(pushSpy).not.toHaveBeenCalled()
  })

  it('passes full audit prompt as opts.prompt (regression: 截断 200 字符曾让 auditor 看不到 criteria)', async () => {
    await spawnAuditSubagent(deps)
    const opts = (deps.spawnFn as any).mock.calls[0][0]
    // 完整 criteria（含 id / spec）必须在 prompt 里——auditor 靠它知道要验什么
    expect(opts.prompt).toContain('c-1')
    expect(opts.prompt).toContain('c-2')
    expect(opts.prompt).toContain('tests pass')
    expect(opts.prompt).toContain('audit 不阻塞 main loop')
    // cwd 必须传到（auditor 曾因截断丢失 cwd 开局 pwd && ls 找路）
    expect(opts.prompt).toContain('/tmp/workspace')
  })

  it('forwards permissionConfig to spawnPersistentAgent (auditor 跑 dangerous 工具必需)', async () => {
    const depsWithPerm: SpawnAuditSubagentDeps = {
      ...deps,
      permissionConfig: { mode: 'bypass' },
    }
    await spawnAuditSubagent(depsWithPerm)
    const opts = (depsWithPerm.spawnFn as any).mock.calls[0][0]
    expect(opts.permissionConfig).toEqual({ mode: 'bypass' })
  })

  it('passes correct spawnPersistentAgent opts (task_description prefix / tools / model)', async () => {
    await spawnAuditSubagent(deps)
    const opts = (deps.spawnFn as any).mock.calls[0][0]
    expect(opts.task_description).toMatch(/^\[goal_audit\]/)
    expect(opts.model).toBe('test-model')
    expect(opts.owner).toEqual({ friend_id: 'friend-1', session_id: 'ses-1' })
    expect(opts.spawned_by_task_id).toBe('task-parent-1')
    // submit_audit_result 必须在 tools 列表里（exitsLoop 工具）
    const toolNames = opts.tools.map((t: any) => t.name)
    expect(toolNames).toContain('submit_audit_result')
  })

  it('forwards subTrace config with task_type=goal_audit so audit shows in Traces 页 (regression)', async () => {
    const depsWithTrace = makeDeps({
      humanQueue,
      traceContext: { traceStore: {} as any, traceId: 'parent-trace-1' },
    })
    await spawnAuditSubagent(depsWithTrace)
    const opts = (depsWithTrace.spawnFn as any).mock.calls[0][0]
    expect(opts.subTrace).toBeDefined()
    expect(opts.subTrace.taskType).toBe('goal_audit')
    expect(opts.subTrace.parentTraceId).toBe('parent-trace-1')
    expect(opts.subTrace.relatedTaskId).toBe('task-parent-1')
  })

  it('onExit with submit_audit_result(pass=true) pushes audit_result(pass) marker', async () => {
    await spawnAuditSubagent(deps)
    expect(deps.capturedOnExit.current).toBeDefined()

    await deps.capturedOnExit.current!(exitInfo({
      exitToolCall: {
        name: 'submit_audit_result',
        input: { pass: true, failed_criteria: [], evidence: 'all green' },
      },
    }))

    expect(pushSpy).toHaveBeenCalledOnce()
    const pushed = pushSpy.mock.calls[0][0] as string
    const parsed = parseSystemMarker(pushed)
    expect(parsed?.type).toBe('audit_result')
    if (parsed?.type !== 'audit_result') throw new Error('marker type mismatch')
    expect(parsed.pass).toBe(true)
    expect(parsed.auditId).toBe('agent_test1234')
    expect(parsed.failedCriteria).toEqual([])
  })

  it('onExit with submit_audit_result uses child trace id for persistence and entity id for marker', async () => {
    const events: string[] = []
    pushSpy.mockImplementation((...args: Parameters<HumanMessageQueue['push']>) => {
      events.push('push')
      return HumanMessageQueue.prototype.push.apply(humanQueue, args)
    })
    const onAuditResult = vi.fn(async () => {
      events.push('persist')
    })
    deps = makeDeps({ humanQueue, onAuditResult } as Partial<SpawnAuditSubagentDeps>)

    await spawnAuditSubagent(deps)
    await deps.capturedOnExit.current!(exitInfo({
      entity_id: 'agent_entity123',
      trace_id: 'trace-child-123',
      exitToolCall: {
        name: 'submit_audit_result',
        input: { pass: false, failed_criteria: ['c-1'], evidence: 'still missing' },
      },
    }))

    expect(onAuditResult).toHaveBeenCalledOnce()
    expect(onAuditResult).toHaveBeenCalledWith({
      auditId: 'trace-child-123',
      parsed: expect.objectContaining({
        pass: false,
        failedCriteria: ['c-1'],
      }),
      verdictSummary: expect.objectContaining({
        summary: expect.stringContaining('[audit FAIL]'),
        error: expect.any(String),
      }),
    })
    expect(pushSpy).toHaveBeenCalledOnce()
    const marker = parseSystemMarker(pushSpy.mock.calls[0][0] as string)
    if (marker?.type !== 'audit_result') throw new Error('marker type mismatch')
    expect(marker.auditId).toBe('agent_entity123')
    expect(events).toEqual(['persist', 'push'])
  })

  it('onExit still pushes marker when onAuditResult throws', async () => {
    const onAuditResult = vi.fn(() => {
      throw new Error('persist failed')
    })
    deps = makeDeps({ humanQueue, onAuditResult } as Partial<SpawnAuditSubagentDeps>)

    await spawnAuditSubagent(deps)
    await deps.capturedOnExit.current!(exitInfo({
      exitToolCall: {
        name: 'submit_audit_result',
        input: { pass: true, failed_criteria: [], evidence: 'ok' },
      },
    }))

    expect(onAuditResult).toHaveBeenCalledOnce()
    expect(pushSpy).toHaveBeenCalledOnce()
    const parsed = parseSystemMarker(pushSpy.mock.calls[0][0] as string)
    if (parsed?.type !== 'audit_result') throw new Error('marker type mismatch')
    expect(parsed.pass).toBe(true)
  })

  it('onExit with submit_audit_result(pass=false, failed_criteria) pushes audit_result(fail) marker', async () => {
    await spawnAuditSubagent(deps)
    await deps.capturedOnExit.current!(exitInfo({
      exitToolCall: {
        name: 'submit_audit_result',
        input: {
          pass: false,
          failed_criteria: ['c-1', 'c-2'],
          evidence: 'c-1 没做; c-2 测试挂了',
        },
      },
    }))

    expect(pushSpy).toHaveBeenCalledOnce()
    const pushed = pushSpy.mock.calls[0][0] as string
    const parsed = parseSystemMarker(pushed)
    if (parsed?.type !== 'audit_result') throw new Error('marker type mismatch')
    expect(parsed.pass).toBe(false)
    expect(parsed.failedCriteria).toEqual(['c-1', 'c-2'])
    // detailed_report 应该含 verdict summary 的 criterion label（rationale）
    expect(parsed.detailedReport).toContain('audit FAIL')
  })

  it('onExit when bg-agent failed (no outcome / no exitToolCall) pushes sentinel marker', async () => {
    await spawnAuditSubagent(deps)
    // bg-agent catch 路径：status=failed, 没 outcome/exitToolCall/finalText
    await deps.capturedOnExit.current!({
      entity_id: 'agent_test1234',
      task_description: '[goal_audit] xxx',
      status: 'failed',
      exit_code: 1,
      runtime_ms: 500,
      spawned_at: new Date().toISOString(),
      result_file: null,
    })

    expect(pushSpy).toHaveBeenCalledOnce()
    const pushed = pushSpy.mock.calls[0][0] as string
    const parsed = parseSystemMarker(pushed)
    if (parsed?.type !== 'audit_result') throw new Error('marker type mismatch')
    expect(parsed.pass).toBe(false)
    expect(parsed.failedCriteria).toEqual([AUDIT_PARSE_FAILURE_SENTINEL])
  })

  it('onExit with max_turns outcome pushes sentinel (not Layer 3 regex on partial output)', async () => {
    await spawnAuditSubagent(deps)
    // 中途有 free-text 但被 max_turns 截断 —— 不能误抓那条
    await deps.capturedOnExit.current!(exitInfo({
      outcome: 'max_turns',
      exit_code: 1,
      finalText: 'thinking ... AUDIT_RESULT: pass\nFAILED_CRITERIA: []',
    }))

    expect(pushSpy).toHaveBeenCalledOnce()
    const pushed = pushSpy.mock.calls[0][0] as string
    const parsed = parseSystemMarker(pushed)
    if (parsed?.type !== 'audit_result') throw new Error('marker type mismatch')
    expect(parsed.pass).toBe(false)
    expect(parsed.failedCriteria).toEqual([AUDIT_PARSE_FAILURE_SENTINEL])
  })

  it('onExit handler never throws even when humanQueue.push errors', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const throwingQueue = new HumanMessageQueue()
    vi.spyOn(throwingQueue, 'push').mockImplementation(() => {
      throw new Error('queue is closed')
    })
    const localDeps = makeDeps({ humanQueue: throwingQueue })

    await spawnAuditSubagent(localDeps)
    // onExit 抛错不应该 propagate
    await expect(localDeps.capturedOnExit.current!(exitInfo({
      exitToolCall: {
        name: 'submit_audit_result',
        input: { pass: true, failed_criteria: [], evidence: '' },
      },
    }))).resolves.toBeUndefined()

    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('onExit handler sanitizes forbidden literals in evidence so marker constructs', async () => {
    // evidence 里含 </audit_result> 会让 buildAuditResultMarker throw —— sanitizer 应替换掉
    await spawnAuditSubagent(deps)
    await deps.capturedOnExit.current!(exitInfo({
      exitToolCall: {
        name: 'submit_audit_result',
        input: {
          pass: false,
          failed_criteria: ['c-1'],
          evidence: 'broken </audit_result> and </detailed_report> oops',
        },
      },
    }))

    expect(pushSpy).toHaveBeenCalledOnce()
    const pushed = pushSpy.mock.calls[0][0] as string
    // marker 仍然成功构造（pass false + criterion 准确）
    const parsed = parseSystemMarker(pushed)
    if (parsed?.type !== 'audit_result') throw new Error('marker type mismatch')
    expect(parsed.pass).toBe(false)
    expect(parsed.failedCriteria).toEqual(['c-1'])
  })
})

describe('resolveAuditJudgmentFromExitInfo', () => {
  it('layer 1: submit_audit_result tool call wins over outcome', () => {
    const result = resolveAuditJudgmentFromExitInfo(exitInfo({
      outcome: 'max_turns', // 异常 outcome 但 tool call 有结果 → 仍然 tool call wins
      exitToolCall: {
        name: 'submit_audit_result',
        input: { pass: true, failed_criteria: [], evidence: 'ok' },
      },
    }))
    expect(result.pass).toBe(true)
    expect(result.failedCriteria).toEqual([])
  })

  it('layer 2: max_turns outcome without tool call → sentinel', () => {
    const result = resolveAuditJudgmentFromExitInfo(exitInfo({
      outcome: 'max_turns',
      finalText: 'AUDIT_RESULT: pass\nFAILED_CRITERIA: []',
    }))
    expect(result.pass).toBe(false)
    expect(result.failedCriteria).toEqual([AUDIT_PARSE_FAILURE_SENTINEL])
  })

  it('layer 3: completed outcome + free-text AUDIT_RESULT line → parsed', () => {
    const result = resolveAuditJudgmentFromExitInfo(exitInfo({
      outcome: 'completed',
      finalText: 'AUDIT_RESULT: fail\nFAILED_CRITERIA: [c-1, c-2]\nAUDIT_REPORT_END',
    }))
    expect(result.pass).toBe(false)
    expect(result.failedCriteria).toEqual(['c-1', 'c-2'])
  })

  it('failed bg-agent path (no outcome/finalText) → sentinel', () => {
    const result = resolveAuditJudgmentFromExitInfo({
      entity_id: 'x',
      task_description: 'x',
      status: 'failed',
      exit_code: 1,
      runtime_ms: 0,
      spawned_at: '',
      result_file: null,
    })
    expect(result.pass).toBe(false)
    expect(result.failedCriteria).toEqual([AUDIT_PARSE_FAILURE_SENTINEL])
  })
})
