import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { buildCoreModules } from './core-modules.js'

const OPTS = {
  crabotRoot: '/repo',
  adminDir: '/repo/crabot-admin',
  agentDir: '/repo/crabot-agent',
  memoryDir: '/repo/crabot-memory',
  dataDir: '/home/u/.crabot/data',
  workspaceDir: '/home/u',
  isDev: false,
  port: 19000,
  adminRpcPort: '19001',
  adminWebPort: '3000',
  mmEndpoint: 'http://localhost:19000',
  adminEndpoint: 'http://localhost:19001',
  newApiToken: '',
  enableFda: '',
}

function envOf(mods: ReturnType<typeof buildCoreModules>, id: string) {
  return mods.find((m) => m.module_id === id)!.env as Record<string, string>
}

describe('buildCoreModules：DATA_DIR 顶层契约', () => {
  it('admin：DATA_DIR=顶层，CRABOT_ADMIN_DATA_DIR=模块级', () => {
    const env = envOf(buildCoreModules(OPTS), 'admin-web')
    expect(env.DATA_DIR).toBe('/home/u/.crabot/data')
    expect(env.CRABOT_ADMIN_DATA_DIR).toBe(join('/home/u/.crabot/data', 'admin'))
  })

  it('agent：DATA_DIR=顶层，CRABOT_AGENT_DATA_DIR=模块级，CRABOT_HOME 已注入', () => {
    const env = envOf(buildCoreModules(OPTS), 'crabot-agent')
    expect(env.DATA_DIR).toBe('/home/u/.crabot/data')
    expect(env.CRABOT_AGENT_DATA_DIR).toBe(join('/home/u/.crabot/data', 'agent'))
    expect(env.CRABOT_HOME).toBe('/repo')
  })

  it('agent/admin 的 DATA_DIR 绝不含模块名后缀（防漂移）', () => {
    const mods = buildCoreModules(OPTS)
    for (const id of ['admin-web', 'crabot-agent']) {
      expect(envOf(mods, id).DATA_DIR).toBe('/home/u/.crabot/data')
    }
  })

  it('memory：仍走 CRABOT_MEMORY_DATA_DIR，env 里不出现 DATA_DIR', () => {
    const env = envOf(buildCoreModules(OPTS), 'memory-default')
    expect(env.CRABOT_MEMORY_DATA_DIR).toBe(join('/home/u/.crabot/data', 'memory'))
    expect(env.DATA_DIR).toBeUndefined()
  })
})
