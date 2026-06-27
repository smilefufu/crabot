import { describe, it, expect, afterEach } from 'vitest'
import { resolve } from 'node:path'
import { getAdminInternalTokenPath } from '../../src/core/data-paths.js'

afterEach(() => {
  delete process.env.CRABOT_AGENT_DATA_DIR
  delete process.env.DATA_DIR
})

describe('internal-token 路径（修复 agent-handler 把 admin 拼到 agent 目录下的 bug）', () => {
  it('token 在顶层 admin 目录，而非 data/agent/admin', () => {
    process.env.CRABOT_AGENT_DATA_DIR = '/x/.crabot/data/agent'
    const p = getAdminInternalTokenPath()
    expect(p).toBe(resolve('/x/.crabot/data/admin', 'internal-token'))
    expect(p).not.toContain('agent/admin')
  })
})
