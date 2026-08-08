/**
 * Admin 模块 - loadData 自愈历史脏数据测试
 *
 * 验证启动加载 tasks.json 时：
 * - 历史脏数据（status=failed 但 waiting_human_at / pending_question 残留）会被修正
 * - 旧 AgentHandler 的非终态 Admin task 在 v3 启动时本地收口为 failed，不尝试 resume
 * - 修正后所有 task 都通过 assertTaskInvariants 兜底
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import AdminModule from './index.js'
import { assertTaskInvariants } from './task-state-machine.js'

const TEST_PROTOCOL_PORT = 19823
const TEST_WEB_PORT = 13023
const TEST_DATA_DIR = './test-data/admin-load-repair-test'

describe('loadData repairs legacy dirty tasks', () => {
  beforeAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })

    // 模拟脏数据：status=failed 但 waiting_human_at + pending_question 残留
    const dirtyTasks = [
      {
        id: 'trigger-dirty-1',
        status: 'failed',
        priority: 'normal',
        title: 'historical orphan',
        description: 'd',
        source: { trigger_type: 'manual', origin: 'human' },
        messages: [],
        tags: [],
        created_at: '2026-06-03T09:00:00.000Z',
        updated_at: '2026-06-04T06:19:40.535Z',
        started_at: '2026-06-03T09:00:00.000Z',
        completed_at: '2026-06-04T06:19:40.535Z',
        error: 'agent_restarted_during_execution',
        waiting_human_at: '2026-06-03T09:11:07.013Z',  // 脏：failed 不该带这个
        pending_question: 'q?',                          // 脏：failed 不该带这个
      },
      {
        id: 'trigger-clean-1',
        status: 'waiting_human',
        priority: 'normal',
        title: 'clean waiting',
        description: 'd',
        source: { trigger_type: 'manual', origin: 'human' },
        messages: [],
        tags: [],
        created_at: '2026-06-04T07:00:00.000Z',
        updated_at: '2026-06-04T07:42:39.399Z',
        started_at: '2026-06-04T07:00:00.000Z',
        waiting_human_at: '2026-06-04T07:42:39.399Z',
        pending_question: 'real q?',
      },
    ]
    await fs.writeFile(
      path.join(TEST_DATA_DIR, 'tasks.json'),
      JSON.stringify(dirtyTasks, null, 2),
    )
  })

  afterAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  it('repairs dirty terminal data and fails retired in-flight legacy tasks on load', async () => {
    const admin = new AdminModule(
      {
        moduleId: 'admin-load-repair-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_PASSWORD_LOAD_REPAIR',
        jwt_secret_env: 'TEST_JWT_SECRET_LOAD_REPAIR',
        token_ttl: 3600,
      }
    )

    process.env.TEST_ADMIN_PASSWORD_LOAD_REPAIR = 'test_password_123'
    process.env.TEST_JWT_SECRET_LOAD_REPAIR = 'test_jwt_secret_at_least_32_chars'

    await admin.start()

    const dirty = (admin as any).tasks.get('trigger-dirty-1')
    expect(dirty.status).toBe('failed')
    expect(dirty.waiting_human_at).toBeUndefined()
    expect(dirty.pending_question).toBeUndefined()
    expect(() => assertTaskInvariants(dirty)).not.toThrow()

    const retired = (admin as any).tasks.get('trigger-clean-1')
    expect(retired.status).toBe('failed')
    expect(retired.error).toBe('legacy Admin task execution retired in Agent v3')
    expect(retired.waiting_human_at).toBeUndefined()
    expect(retired.pending_question).toBeUndefined()
    expect(retired.completed_at).toBeDefined()
    expect(() => assertTaskInvariants(retired)).not.toThrow()

    await admin.stop()
  })
})
