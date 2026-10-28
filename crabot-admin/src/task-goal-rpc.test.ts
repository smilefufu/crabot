/**
 * task-goal RPC handler 集成测试。
 * spec: 2026-05-23-goal-mode-design.md §3
 * plan: 2026-05-23-goal-mode-phase2.md §Task 4
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import AdminModule from './index.js'
import type { AcceptanceCriterion, Task } from './types.js'

const TEST_PROTOCOL_PORT = 19899
const TEST_WEB_PORT = 13099

function sampleCriteria(): AcceptanceCriterion[] {
  return [
    { id: 'c1', kind: 'cmd', spec: 'pnpm typecheck', expect: { exit_code: 0 } },
    { id: 'c2', kind: 'semantic', spec: '功能 X 实现完成' },
  ]
}

describe('task-goal RPC handlers', () => {
  let admin: AdminModule
  let tmpDir: string
  let dataRoot: string

  beforeAll(async () => {
    dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-task-goal-rpc-'))
    tmpDir = path.join(dataRoot, 'admin')
    process.env.TEST_ADMIN_PASSWORD_TG_RPC = 'test_password_123'
    process.env.TEST_JWT_SECRET_TG_RPC = 'test_jwt_secret_at_least_32_chars'
    admin = new AdminModule(
      {
        moduleId: 'admin-task-goal-rpc-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: tmpDir,
        password_env: 'TEST_ADMIN_PASSWORD_TG_RPC',
        jwt_secret_env: 'TEST_JWT_SECRET_TG_RPC',
        token_ttl: 3600,
      }
    )
    await admin.start()
  })

  afterAll(async () => {
    await admin.stop()
    await fs.rm(dataRoot, { recursive: true, force: true })
  })

  async function createBareTask(): Promise<Task> {
    const { task } = await (admin as any).handleCreateTask({
      title: 't',
      source: { trigger_type: 'manual', origin: 'human' },
    })
    return task
  }

  describe('set_task_goal', () => {
    let taskId: string

    beforeEach(async () => {
      taskId = (await createBareTask()).id
    })

    it('成功写入 goal 到 task.goal', async () => {
      const { task } = await (admin as any).handleSetTaskGoal({
        task_id: taskId,
        objective: '实现 X',
        acceptance_criteria: sampleCriteria(),
      })
      expect(task.goal).toBeDefined()
      expect(task.goal.objective).toBe('实现 X')
      expect(task.goal.status).toBe('active')
      expect(task.goal.tokens_used).toBe(0)
      expect(task.goal.audit_history).toEqual([])
    })

    it('token_budget 传入时透传到 goal', async () => {
      const { task } = await (admin as any).handleSetTaskGoal({
        task_id: taskId,
        objective: '实现 X',
        acceptance_criteria: sampleCriteria(),
        token_budget: 100_000,
      })
      expect(task.goal.token_budget).toBe(100_000)
    })

    it('task.goal 为 active 时允许重设并覆盖（反 specification-gaming 锁权已移到 engine 改目标券）', async () => {
      await (admin as any).handleSetTaskGoal({
        task_id: taskId,
        objective: 'first',
        acceptance_criteria: sampleCriteria(),
      })
      const { task } = await (admin as any).handleSetTaskGoal({
        task_id: taskId,
        objective: 'second',
        acceptance_criteria: sampleCriteria(),
      })
      expect(task.goal.status).toBe('active')
      expect(task.goal.objective).toBe('second')
      // 新 goal 全新对象：audit_history 清空，不被旧 fail 历史拖进 blocked
      expect(task.goal.audit_history).toEqual([])
    })

    it('task.goal 为 terminal（cleared）时允许二次 set 写新承诺', async () => {
      // 先 set active goal
      await (admin as any).handleSetTaskGoal({
        task_id: taskId,
        objective: 'first attempt',
        acceptance_criteria: sampleCriteria(),
      })
      // master 通过 clear_task_goal RPC 清掉（模拟 IM /清除目标 slash 路径）
      await (admin as any).handleClearTaskGoal({ task_id: taskId })
      // 现在 task.goal.status === 'cleared'，应允许 agent 重新 set
      const { task } = await (admin as any).handleSetTaskGoal({
        task_id: taskId,
        objective: 'second attempt after clear',
        acceptance_criteria: sampleCriteria(),
      })
      expect(task.goal.status).toBe('active')
      expect(task.goal.objective).toBe('second attempt after clear')
      // 旧 cleared goal 被新 active goal 覆盖（spec §2.3.2 默认 A：不归档）
    })

    it('task 不存在 → 抛 TASK_NOT_FOUND', async () => {
      await expect(
        (admin as any).handleSetTaskGoal({
          task_id: 'nonexistent',
          objective: 'x',
          acceptance_criteria: sampleCriteria(),
        })
      ).rejects.toThrow()
    })

    it('criteria 校验由 task-goal 纯函数兜住：空列表抛错', async () => {
      await expect(
        (admin as any).handleSetTaskGoal({
          task_id: taskId,
          objective: 'x',
          acceptance_criteria: [],
        })
      ).rejects.toThrow(/至少需要 1 条/)
    })
  })

  describe('append_task_goal_audit_entry', () => {
    let taskId: string

    beforeEach(async () => {
      taskId = (await createBareTask()).id
      await (admin as any).handleSetTaskGoal({
        task_id: taskId,
        objective: 'x',
        acceptance_criteria: sampleCriteria(),
      })
    })

    it('追加 audit entry；最新的在前', async () => {
      const entry1 = { at: '2026-05-23T00:00:00.000Z', pass: false, failed_criteria: ['c1'], audit_trace_id: 't1' }
      const entry2 = { at: '2026-05-23T00:01:00.000Z', pass: true, failed_criteria: [], audit_trace_id: 't2' }
      await (admin as any).handleAppendTaskGoalAuditEntry({ task_id: taskId, entry: entry1 })
      const { task } = await (admin as any).handleAppendTaskGoalAuditEntry({ task_id: taskId, entry: entry2 })
      expect(task.goal.audit_history).toHaveLength(2)
      expect(task.goal.audit_history[0]!.audit_trace_id).toBe('t2')
      expect(task.goal.audit_history[1]!.audit_trace_id).toBe('t1')
    })

    it('没 goal 时拒绝', async () => {
      const bareTask = await createBareTask()
      await expect(
        (admin as any).handleAppendTaskGoalAuditEntry({
          task_id: bareTask.id,
          entry: { at: '2026-05-23T00:00:00.000Z', pass: false, failed_criteria: [], audit_trace_id: 't' },
        })
      ).rejects.toThrow(/没有 goal/)
    })

    it('非 active goal 拒绝（complete 后不可再追加）', async () => {
      await (admin as any).handleCompleteTaskGoal({ task_id: taskId })
      await expect(
        (admin as any).handleAppendTaskGoalAuditEntry({
          task_id: taskId,
          entry: { at: '2026-05-23T00:00:00.000Z', pass: false, failed_criteria: [], audit_trace_id: 't' },
        })
      ).rejects.toThrow(/非 active/)
    })
  })

  describe('increment_task_goal_tokens', () => {
    let taskId: string

    beforeEach(async () => {
      taskId = (await createBareTask()).id
    })

    it('无 goal noop（不抛错）', async () => {
      const { task } = await (admin as any).handleIncrementTaskGoalTokens({ task_id: taskId, delta: 100 })
      expect(task.goal).toBeUndefined()
    })

    it('累加 tokens_used', async () => {
      await (admin as any).handleSetTaskGoal({
        task_id: taskId,
        objective: 'x',
        acceptance_criteria: sampleCriteria(),
      })
      await (admin as any).handleIncrementTaskGoalTokens({ task_id: taskId, delta: 100 })
      const { task } = await (admin as any).handleIncrementTaskGoalTokens({ task_id: taskId, delta: 200 })
      expect(task.goal.tokens_used).toBe(300)
      expect(task.goal.status).toBe('active')
    })

    it('超过 token_budget → status=budget_limited', async () => {
      await (admin as any).handleSetTaskGoal({
        task_id: taskId,
        objective: 'x',
        acceptance_criteria: sampleCriteria(),
        token_budget: 500,
      })
      await (admin as any).handleIncrementTaskGoalTokens({ task_id: taskId, delta: 200 })
      const { task } = await (admin as any).handleIncrementTaskGoalTokens({ task_id: taskId, delta: 400 })
      expect(task.goal.status).toBe('budget_limited')
      expect(task.goal.tokens_used).toBe(600)
      expect(task.goal.completed_at).toBeDefined()
    })

    it('task 不存在 → 抛 TASK_NOT_FOUND', async () => {
      await expect(
        (admin as any).handleIncrementTaskGoalTokens({ task_id: 'nonexistent', delta: 100 })
      ).rejects.toThrow()
    })

    it('非 active goal 累加 noop（不 bump updated_at / 不发事件）', async () => {
      await (admin as any).handleSetTaskGoal({
        task_id: taskId,
        objective: 'x',
        acceptance_criteria: sampleCriteria(),
      })
      await (admin as any).handleCompleteTaskGoal({ task_id: taskId })
      const { task: snapshot } = await (admin as any).handleGetTask({ task_id: taskId })
      const updatedAtBefore = snapshot.updated_at
      await new Promise((r) => setTimeout(r, 10)) // ensure 时间戳会不同
      const { task: after } = await (admin as any).handleIncrementTaskGoalTokens({ task_id: taskId, delta: 100 })
      expect(after.updated_at).toBe(updatedAtBefore) // updated_at 未变
      expect(after.goal.status).toBe('complete')
      expect(after.goal.tokens_used).toBe(0) // 没累加
    })
  })

  describe('complete_task_goal', () => {
    let taskId: string

    beforeEach(async () => {
      taskId = (await createBareTask()).id
      await (admin as any).handleSetTaskGoal({
        task_id: taskId,
        objective: 'x',
        acceptance_criteria: sampleCriteria(),
      })
    })

    it('active → complete + completed_at 设置', async () => {
      const { task } = await (admin as any).handleCompleteTaskGoal({ task_id: taskId })
      expect(task.goal.status).toBe('complete')
      expect(task.goal.completed_at).toBeDefined()
    })

    it('没 goal 时拒绝', async () => {
      const bareTask = await createBareTask()
      await expect(
        (admin as any).handleCompleteTaskGoal({ task_id: bareTask.id })
      ).rejects.toThrow(/没有 goal/)
    })

    it('再次 complete 同状态幂等（不抛错）', async () => {
      await (admin as any).handleCompleteTaskGoal({ task_id: taskId })
      const { task } = await (admin as any).handleCompleteTaskGoal({ task_id: taskId })
      expect(task.goal.status).toBe('complete')
    })
  })
})
