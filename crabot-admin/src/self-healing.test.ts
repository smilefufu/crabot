/**
 * Admin 模块 - sweepInterruptedTasksForResume 端到端行为测试
 *
 * 验证：
 * 1. resume sweep 走 applyStatusTransition 后，waiting_human / waiting 任务被标 failed
 *    时不残留 *_at 字段（callAgentRpc 在死 MM 下失败 → resume false → 兜底 failed）。
 * 2. **完整重启（restart_count=0）也跑 sweep**，且 resume 成功的任务保持 executing 不被误杀
 *    —— 这是「完整重启 stop/start 不 resume」根因的回归测试。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import { assertTaskInvariants } from './task-state-machine.js'

const TEST_PROTOCOL_PORT = 19821
const TEST_WEB_PORT = 13021
const TEST_DATA_DIR = './test-data/admin-self-healing-test'

describe('sweepInterruptedTasksForResume through applyStatusTransition', () => {
  let admin: AdminModule

  beforeAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})

    admin = new AdminModule(
      {
        moduleId: 'admin-self-healing-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_PASSWORD_SELF_HEALING',
        jwt_secret_env: 'TEST_JWT_SECRET_SELF_HEALING',
        token_ttl: 3600,
      }
    )

    process.env.TEST_ADMIN_PASSWORD_SELF_HEALING = 'test_password_123'
    process.env.TEST_JWT_SECRET_SELF_HEALING = 'test_jwt_secret_at_least_32_chars'

    await admin.start()
  })

  afterAll(async () => {
    await admin.stop()
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  it('clears waiting_human_at and pending_question when waiting_human → failed', async () => {
    const { task } = await (admin as any).handleCreateTask({
      title: 't',
      description: 'd',
      priority: 'normal',
      source: { trigger_type: 'manual', origin: 'human' },
    })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'planning' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'executing' })
    await (admin as any).handleUpdateTaskStatus({
      task_id: task.id,
      status: 'waiting_human',
      pending_question: 'q?',
    })

    // 触发 resume sweep（死 MM → resume_task RPC 失败 → 兜底 failed）
    await (admin as any).sweepInterruptedTasksForResume(1)

    const healed = (admin as any).tasks.get(task.id)
    expect(healed.status).toBe('failed')
    expect(healed.error).toBe('agent_restarted_during_execution')
    expect(healed.waiting_human_at).toBeUndefined()
    expect(healed.pending_question).toBeUndefined()
    expect(healed.completed_at).toBeDefined()
    expect(() => assertTaskInvariants(healed)).not.toThrow()
  })

  it('clears waiting_at on waiting → failed', async () => {
    const { task } = await (admin as any).handleCreateTask({
      title: 't',
      description: 'd',
      priority: 'normal',
      source: { trigger_type: 'manual', origin: 'human' },
    })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'planning' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'executing' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'waiting' })

    await (admin as any).sweepInterruptedTasksForResume(1)

    const healed = (admin as any).tasks.get(task.id)
    expect(healed.status).toBe('failed')
    expect(healed.waiting_at).toBeUndefined()
    expect(() => assertTaskInvariants(healed)).not.toThrow()
  })

  it('完整重启 restart_count=0 也尝试 resume，resumed 任务保持 executing（回归）', async () => {
    const { task } = await (admin as any).handleCreateTask({
      title: 't',
      description: 'd',
      priority: 'normal',
      source: { trigger_type: 'manual', origin: 'human' },
    })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'planning' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'executing' })

    // 桩：记录 resume_task 调用并返回 resumed:true（模拟 agent 成功接管）
    const calls: Array<{ method: string; params: any }> = []
    const originalRpc = (admin as any).callAgentRpc.bind(admin)
    ;(admin as any).callAgentRpc = async (method: string, params: any) => {
      calls.push({ method, params })
      if (method === 'resume_task') return { resumed: true }
      return {}
    }

    try {
      // restart_count=0（完整重启）—— 旧实现这里直接 return 空转，resume_task 永不调用
      await (admin as any).sweepInterruptedTasksForResume(0)
    } finally {
      ;(admin as any).callAgentRpc = originalRpc
    }

    // 核心断言：完整重启下 resume_task 被调用（不再空转）
    expect(calls.some((c) => c.method === 'resume_task' && c.params.task_id === task.id)).toBe(true)
    // resumed 成功 → 任务保持 executing，不被标 failed
    expect((admin as any).tasks.get(task.id).status).toBe('executing')
  })

  it('module_started 丢失时，轮询兜底仍可靠触发 sweep（agent 延迟就绪）', async () => {
    ;(admin as any).agentPort = 0 // 模拟没接住 agent 的 module_started 事件
    let resolveCalls = 0
    const originalResolve = (admin as any).resolveAgentPort.bind(admin)
    ;(admin as any).resolveAgentPort = async () => {
      resolveCalls++
      ;(admin as any).agentPort = 19999 // 轮询时 agent「注册」上
    }
    let sweepCalled = false
    const originalSweep = (admin as any).sweepInterruptedTasksForResume.bind(admin)
    ;(admin as any).sweepInterruptedTasksForResume = async () => {
      sweepCalled = true
    }

    try {
      await (admin as any).ensureResumeSweepAfterAgentReady(10, 5000)
    } finally {
      ;(admin as any).resolveAgentPort = originalResolve
      ;(admin as any).sweepInterruptedTasksForResume = originalSweep
    }

    expect(resolveCalls).toBeGreaterThanOrEqual(1)
    expect(sweepCalled).toBe(true)
  })

  it('agent 一直不就绪时 sweep 不被调用（超时放弃，不误标 failed）', async () => {
    ;(admin as any).agentPort = 0
    const originalResolve = (admin as any).resolveAgentPort.bind(admin)
    ;(admin as any).resolveAgentPort = async () => {
      /* 永不设 agentPort */
    }
    let sweepCalled = false
    const originalSweep = (admin as any).sweepInterruptedTasksForResume.bind(admin)
    ;(admin as any).sweepInterruptedTasksForResume = async () => {
      sweepCalled = true
    }

    try {
      await (admin as any).ensureResumeSweepAfterAgentReady(5, 30) // 30ms 超时
    } finally {
      ;(admin as any).resolveAgentPort = originalResolve
      ;(admin as any).sweepInterruptedTasksForResume = originalSweep
    }

    expect(sweepCalled).toBe(false)
  })
})
