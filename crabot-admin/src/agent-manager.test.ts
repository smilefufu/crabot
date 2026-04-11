/**
 * AgentManager 测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { AgentManager } from './agent-manager.js'
import type { RpcClient } from 'crabot-shared'
import type { RuntimeManager } from './runtime-manager.js'
import type {
  CreateAgentInstanceParams,
  UpdateAgentInstanceParams,
  UpdateAgentConfigParams,
  AgentImplementation,
} from './types.js'

describe('AgentManager', () => {
  let agentManager: AgentManager
  let testDataDir: string
  let mockRpcClient: RpcClient
  let mockRuntimeManager: RuntimeManager

  beforeEach(async () => {
    // 创建临时测试目录
    testDataDir = path.join(process.cwd(), 'test-data', `agent-manager-${Date.now()}`)
    await fs.mkdir(testDataDir, { recursive: true })

    agentManager = new AgentManager(testDataDir)
    await agentManager.initialize()

    // Mock RpcClient
    mockRpcClient = {
      registerModuleDefinition: vi.fn().mockResolvedValue({ module_id: 'test', registered: true }),
      startModule: vi.fn().mockResolvedValue({ status: 'accepted', tracking_id: 'test-123' }),
      stopModule: vi.fn().mockResolvedValue({ status: 'accepted', tracking_id: 'test-456' }),
      unregisterModuleDefinition: vi.fn().mockResolvedValue({ module_id: 'test', unregistered: true }),
    } as any

    // Mock RuntimeManager
    mockRuntimeManager = {
      createStartCommand: vi.fn().mockReturnValue({
        command: 'node',
        args: ['dist/main.js'],
        cwd: '/test/path',
        env: {},
      }),
    } as any
  })

  afterEach(async () => {
    // 清理测试目录
    try {
      await fs.rm(testDataDir, { recursive: true, force: true })
    } catch {
      // 忽略清理错误
    }
  })

  describe('Implementation CRUD', () => {
    it('should list default implementation', () => {
      const result = agentManager.listImplementations()
      expect(result.items).toHaveLength(1)
      expect(result.items[0].id).toBe('default')
      expect(result.items[0].type).toBe('builtin')
    })

    it('should filter implementations by type', () => {
      const result = agentManager.listImplementations({ type: 'builtin', page: 1, page_size: 20 })
      expect(result.items).toHaveLength(1)
      expect(result.items[0].type).toBe('builtin')
    })

    it('should filter implementations by engine', () => {
      const result = agentManager.listImplementations({ engine: 'claude-agent-sdk', page: 1, page_size: 20 })
      expect(result.items).toHaveLength(1)
      expect(result.items[0].engine).toBe('claude-agent-sdk')
    })

    it('should paginate implementations', () => {
      const result = agentManager.listImplementations({ page: 1, page_size: 1 })
      expect(result.items).toHaveLength(1)
      expect(result.pagination.page).toBe(1)
      expect(result.pagination.page_size).toBe(1)
      expect(result.pagination.total_items).toBe(1)
    })

    it('should get implementation by id', () => {
      const impl = agentManager.getImplementation('default')
      expect(impl).toBeDefined()
      expect(impl?.id).toBe('default')
    })

    it('should return undefined for non-existent implementation', () => {
      const impl = agentManager.getImplementation('non-existent')
      expect(impl).toBeUndefined()
    })

    it('should add new implementation', async () => {
      const newImpl: AgentImplementation = {
        id: 'test-impl',
        name: 'Test Implementation',
        type: 'installed',
        implementation_type: 'full_code',
        engine: 'claude-agent-sdk',
        supported_roles: ['worker'],
        model_format: 'anthropic',
        model_roles: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      await agentManager.addImplementation(newImpl)
      const impl = agentManager.getImplementation('test-impl')
      expect(impl).toBeDefined()
      expect(impl?.name).toBe('Test Implementation')
    })

    it('should not remove builtin default implementation', async () => {
      await expect(agentManager.removeImplementation('default')).rejects.toThrow(
        'Cannot remove builtin default implementation'
      )
    })

    it('should not remove implementation with existing instances', async () => {
      // 先添加一个实现
      const newImpl: AgentImplementation = {
        id: 'test-impl-2',
        name: 'Test Implementation 2',
        type: 'installed',
        implementation_type: 'full_code',
        engine: 'claude-agent-sdk',
        supported_roles: ['worker'],
        model_format: 'anthropic',
        model_roles: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      await agentManager.addImplementation(newImpl)

      // 创建一个使用该实现的实例
      const params: CreateAgentInstanceParams = {
        implementation_id: 'test-impl-2',
        name: 'Test Instance',
        specialization: 'Test',
      }
      await agentManager.createInstance(params)

      // 尝试删除实现应该失败
      await expect(agentManager.removeImplementation('test-impl-2')).rejects.toThrow(
        'Cannot remove implementation with existing instances'
      )
    })
  })

  describe('Instance CRUD', () => {
    it('should list default instance (crabot-agent)', () => {
      const result = agentManager.listInstances()
      expect(result.items).toHaveLength(1)
      expect(result.items[0].id).toBe('crabot-agent')
      expect(result.items[0].name).toBe('Crabot Agent')
    })

    it('should filter instances by implementation_id', () => {
      const result = agentManager.listInstances({ implementation_id: 'default', page: 1, page_size: 20 })
      expect(result.items.every(i => i.implementation_id === 'default')).toBe(true)
    })

    it('should filter instances by auto_start', () => {
      const result = agentManager.listInstances({ auto_start: true, page: 1, page_size: 20 })
      expect(result.items.every(i => i.auto_start === true)).toBe(true)
    })

    it('should get instance by id', () => {
      const instance = agentManager.getInstance('crabot-agent')
      expect(instance).toBeDefined()
      expect(instance?.id).toBe('crabot-agent')
    })

    it('should create new instance', async () => {
      const params: CreateAgentInstanceParams = {
        implementation_id: 'default',
        name: 'Test Worker',
        specialization: 'Testing',
        max_concurrent_tasks: 5,
        auto_start: false,
        start_priority: 30,
      }

      const instance = await agentManager.createInstance(params)
      expect(instance.id).toBe('test-worker')
      expect(instance.name).toBe('Test Worker')
      expect(instance.max_concurrent_tasks).toBe(5)
      expect(instance.auto_start).toBe(false)
      expect(instance.start_priority).toBe(30)
      expect(instance.module_registered).toBe(false)
    })

    it('should create instance with default values', async () => {
      const params: CreateAgentInstanceParams = {
        implementation_id: 'default',
        name: 'Test Agent',
        specialization: 'Testing',
      }

      const instance = await agentManager.createInstance(params)
      expect(instance.max_concurrent_tasks).toBe(5)
      expect(instance.auto_start).toBe(true)
      expect(instance.start_priority).toBe(20)
    })

    it('should throw error for non-existent implementation', async () => {
      const params: CreateAgentInstanceParams = {
        implementation_id: 'non-existent',
        name: 'Test',
        specialization: 'Test',
      }

      await expect(agentManager.createInstance(params)).rejects.toThrow(
        'Implementation not found: non-existent'
      )
    })

    it('should throw error for duplicate instance id', async () => {
      const params: CreateAgentInstanceParams = {
        implementation_id: 'default',
        name: 'Crabot Agent', // 会生成 id: crabot-agent
        specialization: 'Test',
      }

      await expect(agentManager.createInstance(params)).rejects.toThrow(
        'Instance already exists: crabot-agent'
      )
    })

    it('should update instance', async () => {
      const params: UpdateAgentInstanceParams = {
        instance_id: 'crabot-agent',
        name: 'Updated Agent',
        specialization: 'Updated specialization',
        max_concurrent_tasks: 10,
      }

      const updated = await agentManager.updateInstance(params)
      expect(updated.name).toBe('Updated Agent')
      expect(updated.specialization).toBe('Updated specialization')
      expect(updated.max_concurrent_tasks).toBe(10)
    })

    it('should throw error when updating non-existent instance', async () => {
      const params: UpdateAgentInstanceParams = {
        instance_id: 'non-existent',
        name: 'Test',
      }

      await expect(agentManager.updateInstance(params)).rejects.toThrow(
        'Instance not found: non-existent'
      )
    })

    it('should delete instance', async () => {
      // 先创建一个实例
      const createParams: CreateAgentInstanceParams = {
        implementation_id: 'default',
        name: 'To Delete',
        specialization: 'Test',
      }
      await agentManager.createInstance(createParams)

      // 删除实例
      await agentManager.deleteInstance('to-delete')

      // 验证已删除
      const instance = agentManager.getInstance('to-delete')
      expect(instance).toBeUndefined()
    })

    it('should throw error when deleting non-existent instance', async () => {
      await expect(agentManager.deleteInstance('non-existent')).rejects.toThrow(
        'Instance not found: non-existent'
      )
    })
  })

  describe('Instance with Module Registration', () => {
    let installedImpl: AgentImplementation

    beforeEach(async () => {
      // 创建一个已安装的实现
      installedImpl = {
        id: 'installed-test',
        name: 'Installed Test',
        type: 'installed',
        implementation_type: 'full_code',
        engine: 'claude-agent-sdk',
        supported_roles: ['worker'],
        model_format: 'anthropic',
        model_roles: [],
        installed_path: '/test/installed/path',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      await agentManager.addImplementation(installedImpl)
    })

    it('should register and start module when creating instance', async () => {
      const params: CreateAgentInstanceParams = {
        implementation_id: 'installed-test',
        name: 'Test Module Instance',
        specialization: 'Test',
        auto_start: true,
      }

      const instance = await agentManager.createInstance(
        params,
        mockRpcClient,
        mockRuntimeManager
      )

      expect(instance.module_registered).toBe(true)
      expect(mockRuntimeManager.createStartCommand).toHaveBeenCalled()
      expect(mockRpcClient.registerModuleDefinition).toHaveBeenCalled()
      expect(mockRpcClient.startModule).toHaveBeenCalledWith('test-module-instance', 'admin')
    })

    it('should not start module when auto_start is false', async () => {
      const params: CreateAgentInstanceParams = {
        implementation_id: 'installed-test',
        name: 'Test No Start',
        specialization: 'Test',
        auto_start: false,
      }

      await agentManager.createInstance(params, mockRpcClient, mockRuntimeManager)

      expect(mockRpcClient.registerModuleDefinition).toHaveBeenCalled()
      expect(mockRpcClient.startModule).not.toHaveBeenCalled()
    })

    it('should rollback on registration failure', async () => {
      // Mock 注册失败
      mockRpcClient.registerModuleDefinition = vi.fn().mockRejectedValue(new Error('Registration failed'))

      const params: CreateAgentInstanceParams = {
        implementation_id: 'installed-test',
        name: 'Test Rollback',
        specialization: 'Test',
      }

      await expect(
        agentManager.createInstance(params, mockRpcClient, mockRuntimeManager)
      ).rejects.toThrow('Registration failed')

      // 验证实例已回滚
      const instance = agentManager.getInstance('test-rollback')
      expect(instance).toBeUndefined()
    })

    it('should stop and unregister module when deleting instance', async () => {
      // 先创建一个已注册的实例
      const params: CreateAgentInstanceParams = {
        implementation_id: 'installed-test',
        name: 'Test Delete Module',
        specialization: 'Test',
      }
      await agentManager.createInstance(params, mockRpcClient, mockRuntimeManager)

      // 删除实例
      await agentManager.deleteInstance('test-delete-module', mockRpcClient)

      expect(mockRpcClient.stopModule).toHaveBeenCalledWith('test-delete-module', 'admin')
      expect(mockRpcClient.unregisterModuleDefinition).toHaveBeenCalledWith('test-delete-module', 'admin')
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

  describe('Auto-start instances', () => {
    it('should get auto-start instances sorted by priority', () => {
      const instances = agentManager.getAutoStartInstances()
      expect(instances.length).toBeGreaterThanOrEqual(1)
      expect(instances.every(i => i.auto_start === true)).toBe(true)
      expect(instances[0].id).toBe('crabot-agent')

      // 验证排序
      for (let i = 1; i < instances.length; i++) {
        expect(instances[i].start_priority).toBeGreaterThanOrEqual(instances[i - 1].start_priority)
      }
    })
  })

  describe('Data persistence', () => {
    it('should persist implementations', async () => {
      const newImpl: AgentImplementation = {
        id: 'persist-test',
        name: 'Persist Test',
        type: 'installed',
        implementation_type: 'full_code',
        engine: 'claude-agent-sdk',
        supported_roles: ['worker'],
        model_format: 'anthropic',
        model_roles: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      await agentManager.addImplementation(newImpl)

      // 创建新的 AgentManager 实例来验证持久化
      const newManager = new AgentManager(testDataDir)
      await newManager.initialize()

      const impl = newManager.getImplementation('persist-test')
      expect(impl).toBeDefined()
      expect(impl?.name).toBe('Persist Test')
    })

    it('should persist instances', async () => {
      const params: CreateAgentInstanceParams = {
        implementation_id: 'default',
        name: 'Persist Instance',
        specialization: 'Test',
      }

      await agentManager.createInstance(params)

      // 创建新的 AgentManager 实例来验证持久化
      const newManager = new AgentManager(testDataDir)
      await newManager.initialize()

      const instance = newManager.getInstance('persist-instance')
      expect(instance).toBeDefined()
      expect(instance?.name).toBe('Persist Instance')
    })

    it('should persist configs', async () => {
      const params: UpdateAgentConfigParams = {
        instance_id: 'crabot-agent',
        system_prompt: 'Persisted prompt',
      }

      await agentManager.updateConfig(params)

      // 创建新的 AgentManager 实例来验证持久化
      const newManager = new AgentManager(testDataDir)
      await newManager.initialize()

      const config = newManager.getConfig('crabot-agent')
      expect(config).toBeDefined()
      expect(config?.system_prompt).toBe('Persisted prompt')
    })
  })
})
