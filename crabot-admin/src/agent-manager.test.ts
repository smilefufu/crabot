/**
 * AgentManager（P6-D 收窄为 core Agent 配置存储）测试。
 *
 * 动态 AgentImplementation/AgentInstance CRUD 已退役：旧「创建/更新/删除实例」断言
 * 不是删除覆盖，而是改为「方法不存在/静态身份只读」的早拒绝语义断言。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { AgentManager } from './agent-manager.js'
import type { UpdateAgentConfigParams } from './types.js'

describe('AgentManager (P6-D core-config-only)', () => {
  let agentManager: AgentManager
  let testDataDir: string

  beforeEach(async () => {
    testDataDir = path.join(process.cwd(), 'test-data', `agent-manager-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await fs.mkdir(testDataDir, { recursive: true })
    agentManager = new AgentManager(testDataDir)
    await agentManager.initialize()
    await agentManager.initializeCoreDefaultsAndMigrations()
  })

  afterEach(async () => {
    try { await fs.rm(testDataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('loads persisted core config without default writes and preserves it across restart', async () => {
    const dir = path.join(process.cwd(), 'test-data', `agent-manager-load-${Date.now()}`)
    const configDir = path.join(dir, 'agent-configs')
    try {
      await fs.mkdir(configDir, { recursive: true })
      const persisted = { instance_id: 'crabot-agent', system_prompt: 'persisted', model_config: { powerful: { provider_id: 'p', model_id: 'm' } }, max_iterations: 7, tools_readonly: true }
      await fs.writeFile(path.join(configDir, 'crabot-agent.json'), JSON.stringify(persisted))
      const manager = new AgentManager(dir)
      await manager.initialize()
      expect(manager.getConfig('crabot-agent')).toMatchObject(persisted)
      const before = await fs.readFile(path.join(configDir, 'crabot-agent.json'), 'utf8')
      expect(before).toContain('persisted')
      const restarted = new AgentManager(dir)
      await restarted.initialize()
      expect(restarted.getConfig('crabot-agent')).toMatchObject(persisted)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  describe('退役语义（替代旧 dynamic CRUD 断言）', () => {
    it('动态 implementation/instance 写方法不存在', () => {
      const m = agentManager as unknown as Record<string, unknown>
      for (const key of ['addImplementation', 'removeImplementation', 'createInstance', 'updateInstance', 'deleteInstance', 'getAutoStartInstances']) {
        expect(m[key]).toBeUndefined()
      }
    })

    it('静态身份只读：getImplementation(default/crabot-agent) 返回静态定义，其它返回 undefined', () => {
      expect(agentManager.getImplementation('default')?.id).toBe('crabot-agent')
      expect(agentManager.getImplementation('crabot-agent')?.id).toBe('crabot-agent')
      expect(agentManager.getImplementation('whatever')).toBeUndefined()
      expect(agentManager.getInstance('crabot-agent')?.id).toBe('crabot-agent')
      expect(agentManager.getInstance('other')).toBeUndefined()
    })

    it('stale/malformed legacy registry 文件不影响 core config 与静态身份', async () => {
      await fs.writeFile(path.join(testDataDir, 'agent-implementations.json'), '[{"id":"evil","model_roles":[{"key":"hacked"}]}]')
      await fs.writeFile(path.join(testDataDir, 'agent-instances.json'), 'not json')
      await fs.mkdir(path.join(testDataDir, 'agent-configs'), { recursive: true })
      await fs.writeFile(path.join(testDataDir, 'agent-configs', 'front-agent.json'), JSON.stringify({ instance_id: 'front-agent', system_prompt: 'legacy' }))
      const manager = new AgentManager(testDataDir)
      await manager.initialize()
      await manager.initializeCoreDefaultsAndMigrations()
      expect(manager.getImplementation('default')?.model_roles.some((r) => r.key === 'powerful')).toBe(true)
      expect(manager.getConfig('front-agent')).toBeUndefined()
      expect(manager.getConfig('crabot-agent')).toBeDefined()
    })

    it('空 core config 是合法未配置状态（不自动创建 dynamic instance）', async () => {
      const fresh = new AgentManager(path.join(testDataDir, 'fresh'))
      await fresh.initialize()
      expect(fresh.getConfig('crabot-agent')).toBeUndefined()
      const m = fresh as unknown as Record<string, unknown>
      expect(m.createInstance).toBeUndefined()
    })
  })

  describe('Config CRUD', () => {
    it('should get default config for crabot-agent', () => {
      const config = agentManager.getConfig('crabot-agent')
      expect(config).toBeDefined()
      expect(config?.instance_id).toBe('crabot-agent')
      expect(config?.max_iterations).toBe(10)
      expect(config?.tools_readonly).toBe(false)
    })

    it('should return undefined for non-existent config', () => {
      const config = agentManager.getConfig('non-existent')
      expect(config).toBeUndefined()
    })

    it('should update config', async () => {
      const params: UpdateAgentConfigParams = {
        instance_id: 'crabot-agent',
        system_prompt: 'Updated prompt',
        max_iterations: 5,
      }

      const updated = await agentManager.updateConfig(params)
      expect(updated.system_prompt).toBe('Updated prompt')
      expect(updated.max_iterations).toBe(5)
      expect(updated.tools_readonly).toBe(false) // 保持原值
    })

    it('classifies core semantic config mutations by changed domain', async () => {
      const calls: string[][] = []
      agentManager.setMutationRunner(async (domains, _preview, apply) => {
        calls.push([...domains])
        await apply({} as any)
      })

      await agentManager.updateConfig({ instance_id: 'crabot-agent', system_prompt: 'behavior change' })
      await agentManager.updateConfig({
        instance_id: 'crabot-agent',
        model_config: { powerful: { provider_id: 'provider', model_id: 'model' } },
      })
      await agentManager.updateConfig({
        instance_id: 'crabot-agent',
        system_prompt: 'combined behavior change',
        model_config: { powerful: { provider_id: 'provider-2', model_id: 'model-2' } },
      })
      await agentManager.updateConfig({ instance_id: 'crabot-agent', mcp_server_ids: ['legacy-only'] })

      expect(calls).toEqual([['behavior'], ['models'], ['models', 'behavior']])
    })

    it('serializes concurrent disjoint core config patches', async () => {
      await Promise.all([
        agentManager.updateConfig({ instance_id: 'crabot-agent', system_prompt: 'concurrent prompt' }),
        agentManager.updateConfig({ instance_id: 'crabot-agent', timezone: 'UTC' }),
      ])
      expect(agentManager.getConfig('crabot-agent')).toMatchObject({
        system_prompt: 'concurrent prompt', timezone: 'UTC',
      })
    })

    it('does not run a semantic mutation for an unchanged core config value', async () => {
      const calls: string[][] = []
      agentManager.setMutationRunner(async (domains, _preview, apply) => {
        calls.push([...domains])
        await apply({} as any)
      })
      const current = agentManager.getConfig('crabot-agent')!

      await agentManager.updateConfig({ instance_id: 'crabot-agent', system_prompt: current.system_prompt })

      expect(calls).toEqual([])
    })
    it('should throw error when updating non-existent config', async () => {
      const params: UpdateAgentConfigParams = {
        instance_id: 'non-existent',
        system_prompt: 'Test',
      }

      await expect(agentManager.updateConfig(params)).rejects.toThrow(
        'Config not found for instance: non-existent'
      )
    })
  })

  describe('manager model slot（additive，protocol-agent-v3 §11）', () => {
    it('builtin model_roles 含 manager，required=false', () => {
      const impl = agentManager.getImplementation('default')
      const managerRole = impl?.model_roles.find((r) => r.key === 'manager')
      expect(managerRole).toBeDefined()
      expect(managerRole?.required).toBe(false)
    })

    it('既有配置（无 manager 键）启动迁移后仍有效，不报错、不被强行补 manager 键', async () => {
      // 模拟一份"迁移前"就已经存在于磁盘的实例配置：只有 powerful，没有 manager。
      const preExistingDataDir = path.join(process.cwd(), 'test-data', `agent-manager-legacy-${Date.now()}`)
      await fs.mkdir(path.join(preExistingDataDir, 'agent-configs'), { recursive: true })
      const legacyConfig = {
        instance_id: 'crabot-agent',
        system_prompt: '',
        model_config: { powerful: { provider_id: 'p1', model_id: 'm1' } },
        max_iterations: 10,
        tools_readonly: false,
      }
      await fs.writeFile(
        path.join(preExistingDataDir, 'agent-configs', 'crabot-agent.json'),
        JSON.stringify(legacyConfig, null, 2)
      )

      try {
        const legacyManager = new AgentManager(preExistingDataDir)
        await expect(legacyManager.initialize()).resolves.not.toThrow()

        const config = legacyManager.getConfig('crabot-agent')
        expect(config).toBeDefined()
        expect(config?.model_config).toEqual({ powerful: { provider_id: 'p1', model_id: 'm1' } })
        expect(config?.model_config?.manager).toBeUndefined()
      } finally {
        await fs.rm(preExistingDataDir, { recursive: true, force: true })
      }
    })
  })

})
