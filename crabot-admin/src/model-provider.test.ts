/**
 * Model Provider Manager 单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { ModelProviderManager } from './model-provider-manager.js'
import type { CreateModelProviderParams, ModelProvider } from './types.js'

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
      // 直连 Provider，返回 provider 的原始格式
      expect(connectionInfo.format).toBe('openai')
    })

    it('module config overrides global default for the same role', async () => {
      // 创建两个 provider（global 默认用 A，模块覆盖用 B），验证 module 配置优先
      const globalProvider = await manager.createProvider({
        name: 'Global Provider',
        type: 'manual',
        format: 'openai',
        endpoint: 'http://global.example/v1',
        api_key: 'global-key',
        models: [{ model_id: 'global-llm', display_name: 'Global LLM', type: 'llm' }],
      })
      const moduleProvider = await manager.createProvider({
        name: 'Module Provider',
        type: 'manual',
        format: 'openai',
        endpoint: 'http://module.example/v1',
        api_key: 'module-key',
        models: [{ model_id: 'module-llm', display_name: 'Module LLM', type: 'llm' }],
      })

      await manager.updateGlobalConfig({
        default_llm_provider_id: globalProvider.id,
        default_llm_model_id: 'global-llm',
      })
      await manager.updateModuleConfig('test-module', {
        llm_provider_id: moduleProvider.id,
        llm_model_id: 'module-llm',
      })

      const connectionInfo = await manager.resolveModelConfig({
        module_id: 'test-module',
        role: 'llm',
      })

      // 应解析到 module 级配置而非 global 默认
      expect(connectionInfo.endpoint).toBe('http://module.example/v1')
      expect(connectionInfo.apikey).toBe('module-key')
      expect(connectionInfo.model_id).toBe('module-llm')
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

    it('preserves manual image selection across restart', async () => {
      await manager.updateGlobalConfig({
        default_image_provider_id: 'image-provider',
        default_image_model_id: 'image-model',
        image_slot_user_set: true,
      })
      const newManager = new ModelProviderManager(testDataDir)
      await newManager.initialize()
      expect(newManager.getGlobalConfig()).toMatchObject({
        default_image_provider_id: 'image-provider',
        default_image_model_id: 'image-model',
        image_slot_user_set: true,
      })
    })

    it('preserves auto-selected image fields across restart', async () => {
      await manager.updateGlobalConfig({
        default_image_provider_id: 'auto-image-provider',
        default_image_model_id: 'auto-image-model',
        image_slot_user_set: false,
      })
      const newManager = new ModelProviderManager(testDataDir)
      await newManager.initialize()
      expect(newManager.getGlobalConfig()).toMatchObject({
        default_image_provider_id: 'auto-image-provider',
        default_image_model_id: 'auto-image-model',
        image_slot_user_set: false,
      })
    })
  })

  describe('upsertById', () => {
    const makeProvider = (id: string, name: string): ModelProvider => ({
      id,
      name,
      type: 'manual',
      format: 'openai',
      endpoint: 'http://localhost:11434/v1',
      api_key: 'key',
      models: [],
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    })

    it('新 id → 返回 imported，可查到', async () => {
      const p = makeProvider('provider-import-1', 'Test Import')
      const result = await manager.upsertById(p, 'skip')
      expect(result).toBe('imported')
      expect(manager.getProvider('provider-import-1')?.name).toBe('Test Import')
    })

    it('同 id + skip → 返回 skipped，值不变', async () => {
      const p = makeProvider('provider-import-2', 'Original')
      await manager.upsertById(p, 'skip')
      const result = await manager.upsertById(makeProvider('provider-import-2', 'Updated'), 'skip')
      expect(result).toBe('skipped')
      expect(manager.getProvider('provider-import-2')?.name).toBe('Original')
    })

    it('同 id + overwrite → 返回 overwritten，值更新', async () => {
      const p = makeProvider('provider-import-3', 'Original')
      await manager.upsertById(p, 'skip')
      const result = await manager.upsertById(makeProvider('provider-import-3', 'Updated'), 'overwrite')
      expect(result).toBe('overwritten')
      expect(manager.getProvider('provider-import-3')?.name).toBe('Updated')
    })
  })

  describe('buildConnectionInfo', () => {
    it('透传模型级可选字段 max_tokens / supports_vision / context_window', async () => {
      const provider = await manager.createProvider({
        name: 'Conn Info Provider',
        type: 'manual',
        format: 'openai',
        endpoint: 'http://localhost:11434/v1',
        api_key: 'test-key',
        models: [
          {
            model_id: 'full-model',
            display_name: 'Full Model',
            type: 'llm',
            max_tokens: 8192,
            supports_vision: true,
            context_window: 131072,
          },
          {
            model_id: 'bare-model',
            display_name: 'Bare Model',
            type: 'llm',
          },
        ],
      })

      const full = await manager.buildConnectionInfo(provider.id, 'full-model')
      expect(full.max_tokens).toBe(8192)
      expect(full.supports_vision).toBe(true)
      expect(full.context_window).toBe(131072)

      // 未配置 context_window 的模型不应带出该字段（agent 侧走 200000 回退）
      const bare = await manager.buildConnectionInfo(provider.id, 'bare-model')
      expect(bare.context_window).toBeUndefined()
      expect('context_window' in bare).toBe(false)
    })
  })
})
