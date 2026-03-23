/**
 * Model Provider Manager 单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { ModelProviderManager } from './model-provider-manager.js'
import type { CreateModelProviderParams } from './types.js'

describe('ModelProviderManager', () => {
  const testDataDir = path.join(process.cwd(), 'test-data', 'model-provider-test')
  let manager: ModelProviderManager

  beforeEach(async () => {
    // 清理测试目录
    await fs.rm(testDataDir, { recursive: true, force: true })
    await fs.mkdir(testDataDir, { recursive: true })

    manager = new ModelProviderManager(testDataDir)
    await manager.initialize()
  })

  afterEach(async () => {
    // 清理测试目录
    await fs.rm(testDataDir, { recursive: true, force: true })
  })

  describe('Provider CRUD', () => {
    it('should create a provider', async () => {
      const params: CreateModelProviderParams = {
        name: 'Test Provider',
        type: 'manual',
        format: 'openai',
        endpoint: 'http://localhost:11434/v1',
        api_key: 'test-key',
        models: [
          {
            model_id: 'test-model',
            display_name: 'Test Model',
            type: 'llm',
          },
        ],
      }

      const provider = await manager.createProvider(params)

      expect(provider.id).toBeDefined()
      expect(provider.name).toBe('Test Provider')
      expect(provider.format).toBe('openai')
      expect(provider.models).toHaveLength(1)
      expect(provider.status).toBe('active')
    })

    it('should list providers', async () => {
      const params: CreateModelProviderParams = {
        name: 'Provider 1',
        type: 'manual',
        format: 'openai',
        endpoint: 'http://localhost:11434/v1',
        api_key: 'key1',
        models: [],
      }

      await manager.createProvider(params)
      await manager.createProvider({ ...params, name: 'Provider 2', api_key: 'key2' })

      const providers = manager.listProviders()
      expect(providers).toHaveLength(2)
    })

    it('should get a provider by id', async () => {
      const params: CreateModelProviderParams = {
        name: 'Test Provider',
        type: 'manual',
        format: 'openai',
        endpoint: 'http://localhost:11434/v1',
        api_key: 'test-key',
        models: [],
      }

      const created = await manager.createProvider(params)
      const retrieved = manager.getProvider(created.id)

      expect(retrieved).toBeDefined()
      expect(retrieved?.id).toBe(created.id)
      expect(retrieved?.name).toBe('Test Provider')
    })

    it('should update a provider', async () => {
      const params: CreateModelProviderParams = {
        name: 'Original Name',
        type: 'manual',
        format: 'openai',
        endpoint: 'http://localhost:11434/v1',
        api_key: 'test-key',
        models: [],
      }

      const created = await manager.createProvider(params)
      const updated = await manager.updateProvider(created.id, {
        name: 'Updated Name',
        status: 'inactive',
      })

      expect(updated.name).toBe('Updated Name')
      expect(updated.status).toBe('inactive')
    })

    it('should delete a provider', async () => {
      const params: CreateModelProviderParams = {
        name: 'Test Provider',
        type: 'manual',
        format: 'openai',
        endpoint: 'http://localhost:11434/v1',
        api_key: 'test-key',
        models: [],
      }

      const created = await manager.createProvider(params)
      await manager.deleteProvider(created.id)

      const retrieved = manager.getProvider(created.id)
      expect(retrieved).toBeUndefined()
    })
  })

  describe('Global Config', () => {
    it('should get default global config', () => {
      const config = manager.getGlobalConfig()
      expect(config).toBeDefined()
    })

    it('should update global config', async () => {
      const params: CreateModelProviderParams = {
        name: 'Test Provider',
        type: 'manual',
        format: 'openai',
        endpoint: 'http://localhost:11434/v1',
        api_key: 'test-key',
        models: [
          {
            model_id: 'test-llm',
            display_name: 'Test LLM',
            type: 'llm',
          },
        ],
      }

      const provider = await manager.createProvider(params)

      const updated = await manager.updateGlobalConfig({
        default_llm_provider_id: provider.id,
        default_llm_model_id: 'test-llm',
      })

      expect(updated.default_llm_provider_id).toBe(provider.id)
      expect(updated.default_llm_model_id).toBe('test-llm')
    })
  })

  describe('Module Config', () => {
    it('should update module config', async () => {
      const params: CreateModelProviderParams = {
        name: 'Test Provider',
        type: 'manual',
        format: 'openai',
        endpoint: 'http://localhost:11434/v1',
        api_key: 'test-key',
        models: [
          {
            model_id: 'test-embedding',
            display_name: 'Test Embedding',
            type: 'embedding',
            dimension: 1536,
          },
        ],
      }

      const provider = await manager.createProvider(params)

      const config = await manager.updateModuleConfig('memory-default', {
        embedding_provider_id: provider.id,
        embedding_model_id: 'test-embedding',
      })

      expect(config.module_id).toBe('memory-default')
      expect(config.embedding_provider_id).toBe(provider.id)
      expect(config.embedding_model_id).toBe('test-embedding')
    })

    it('should list module configs', async () => {
      await manager.updateModuleConfig('module-1', {
        llm_provider_id: 'provider-1',
      })
      await manager.updateModuleConfig('module-2', {
        llm_provider_id: 'provider-2',
      })

      const configs = manager.listModuleConfigs()
      expect(configs).toHaveLength(2)
    })

    it('should delete module config', async () => {
      await manager.updateModuleConfig('test-module', {
        llm_provider_id: 'provider-1',
      })

      await manager.deleteModuleConfig('test-module')

      const config = manager.getModuleConfig('test-module')
      expect(config).toBeUndefined()
    })
  })

  describe('Config Resolution', () => {
    it('should resolve model config from global config', async () => {
      const params: CreateModelProviderParams = {
        name: 'Test Provider',
        type: 'manual',
        format: 'openai',
        endpoint: 'http://localhost:11434/v1',
        api_key: 'test-key',
        models: [
          {
            model_id: 'test-llm',
            display_name: 'Test LLM',
            type: 'llm',
          },
        ],
      }

      const provider = await manager.createProvider(params)

      await manager.updateGlobalConfig({
        default_llm_provider_id: provider.id,
        default_llm_model_id: 'test-llm',
      })

      const connectionInfo = await manager.resolveModelConfig({
        module_id: 'test-module',
        role: 'llm',
      })

      expect(connectionInfo.endpoint).toBe('http://localhost:11434/v1')
      expect(connectionInfo.apikey).toBe('test-key')
      expect(connectionInfo.model_id).toBe('test-llm')
      // Agent 使用 Anthropic SDK，LiteLLM 提供格式转换
      expect(connectionInfo.format).toBe('anthropic')
    })

    it('should resolve model config from module config', async () => {
      const params: CreateModelProviderParams = {
        name: 'Test Provider',
        type: 'manual',
        format: 'openai',
        endpoint: 'http://localhost:11434/v1',
        api_key: 'test-key',
        models: [
          {
            model_id: 'test-embedding',
            display_name: 'Test Embedding',
            type: 'embedding',
            dimension: 1536,
          },
        ],
      }

      const provider = await manager.createProvider(params)

      await manager.updateModuleConfig('memory-default', {
        embedding_provider_id: provider.id,
        embedding_model_id: 'test-embedding',
      })

      const connectionInfo = await manager.resolveModelConfig({
        module_id: 'memory-default',
        role: 'embedding',
      })

      expect(connectionInfo.endpoint).toBe('http://localhost:11434/v1')
      expect(connectionInfo.model_id).toBe('test-embedding')
      expect(connectionInfo.dimension).toBe(1536)
    })

    it('should throw error when no config found', async () => {
      await expect(
        manager.resolveModelConfig({
          module_id: 'unknown-module',
          role: 'llm',
        })
      ).rejects.toThrow()
    })
  })

  describe('Persistence', () => {
    it('should persist providers across restarts', async () => {
      const params: CreateModelProviderParams = {
        name: 'Persistent Provider',
        type: 'manual',
        format: 'openai',
        endpoint: 'http://localhost:11434/v1',
        api_key: 'test-key',
        models: [],
      }

      const created = await manager.createProvider(params)

      // 创建新的 manager 实例（模拟重启）
      const newManager = new ModelProviderManager(testDataDir)
      await newManager.initialize()

      const retrieved = newManager.getProvider(created.id)
      expect(retrieved).toBeDefined()
      expect(retrieved?.name).toBe('Persistent Provider')
    })

    it('should persist global config across restarts', async () => {
      await manager.updateGlobalConfig({
        default_llm_provider_id: 'provider-1',
        default_llm_model_id: 'model-1',
      })

      // 创建新的 manager 实例（模拟重启）
      const newManager = new ModelProviderManager(testDataDir)
      await newManager.initialize()

      const config = newManager.getGlobalConfig()
      expect(config.default_llm_provider_id).toBe('provider-1')
      expect(config.default_llm_model_id).toBe('model-1')
    })
  })
})
