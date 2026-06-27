import { describe, it, expect, afterEach } from 'vitest'
import { resolve } from 'node:path'
import {
  getAgentDataDir,
  getAgentLogsDir,
  getAdminDataDir,
  getAdminInternalTokenPath,
} from '../../src/core/data-paths.js'

const ENV_KEYS = ['CRABOT_AGENT_DATA_DIR', 'DATA_DIR'] as const
function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k]
}

describe('data-paths：agent 数据目录解析', () => {
  afterEach(clearEnv)

  it('CRABOT_AGENT_DATA_DIR 存在时优先用它（模块级）', () => {
    clearEnv()
    process.env.CRABOT_AGENT_DATA_DIR = '/x/.crabot/data/agent'
    expect(getAgentDataDir()).toBe(resolve('/x/.crabot/data/agent'))
  })

  it('仅顶层 DATA_DIR 时，join("agent") 推导出模块级', () => {
    clearEnv()
    process.env.DATA_DIR = '/x/.crabot/data'
    expect(getAgentDataDir()).toBe(resolve('/x/.crabot/data', 'agent'))
  })

  it('都没有时回退 ./data/agent', () => {
    clearEnv()
    expect(getAgentDataDir()).toBe(resolve('./data/agent'))
  })

  it('getAdminDataDir 是 agent 目录的兄弟 admin', () => {
    clearEnv()
    process.env.CRABOT_AGENT_DATA_DIR = '/x/.crabot/data/agent'
    expect(getAdminDataDir()).toBe(resolve('/x/.crabot/data/agent', '..', 'admin'))
    expect(getAdminInternalTokenPath()).toBe(resolve('/x/.crabot/data/admin', 'internal-token'))
  })

  it('getAgentLogsDir = agent 目录下 logs', () => {
    clearEnv()
    process.env.CRABOT_AGENT_DATA_DIR = '/x/.crabot/data/agent'
    expect(getAgentLogsDir()).toBe(resolve('/x/.crabot/data/agent', 'logs'))
  })
})
