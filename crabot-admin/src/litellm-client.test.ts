/**
 * LiteLLM 客户端单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiteLLMClient } from './litellm-client.js'
import type { LiteLLMModelConfig, LiteLLMGenerateKeyParams } from './types.js'

// Mock HTTP 模块
vi.mock('http', () => ({
  default: {
    request: vi.fn(),
  },
}))

vi.mock('https', () => ({
  default: {
    request: vi.fn(),
  },
}))

describe('LiteLLMClient', () => {
  let client: LiteLLMClient
  const mockConfig = {
    baseUrl: 'http://localhost:4000',
    masterKey: 'sk-test-master-key',
  }

  beforeEach(() => {
    client = new LiteLLMClient(mockConfig)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('构造函数', () => {
    it('should create client with config', () => {
      expect(client).toBeDefined()
    })

    it('should remove trailing slash from baseUrl', () => {
      const clientWithSlash = new LiteLLMClient({
        baseUrl: 'http://localhost:4000/',
        masterKey: 'test-key',
      })
      expect((clientWithSlash as any).baseUrl).toBe('http://localhost:4000')
    })
  })

  describe('createModel', () => {
    it('should call /model/new endpoint', async () => {
      const config: LiteLLMModelConfig = {
        model_name: 'test-model',
        litellm_params: {
          model: 'openai/gpt-4o',
          api_key: 'test-api-key',
        },
      }

      // Mock 成功响应
      const mockResponse = { success: true }
      vi.spyOn(client as any, 'httpRequest').mockResolvedValue(JSON.stringify(mockResponse))

      await client.createModel(config)

      expect((client as any).httpRequest).toHaveBeenCalledWith(
        '/model/new',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(config),
        })
      )
    })

    it('should throw error on failure', async () => {
      const config: LiteLLMModelConfig = {
        model_name: 'test-model',
        litellm_params: {
          model: 'openai/gpt-4o',
          api_key: 'test-api-key',
        },
      }

      vi.spyOn(client as any, 'httpRequest').mockRejectedValue(new Error('Request failed'))

      await expect(client.createModel(config)).rejects.toThrow('Request failed')
    })
  })

  describe('deleteModel', () => {
    it('should call /model/delete endpoint', async () => {
      const mockResponse = { success: true }
      vi.spyOn(client as any, 'httpRequest').mockResolvedValue(JSON.stringify(mockResponse))

      await client.deleteModel('test-model')

      expect((client as any).httpRequest).toHaveBeenCalledWith(
        '/model/delete',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ model_id: 'test-model' }),
        })
      )
    })
  })

  describe('listModels', () => {
    it('should return list of models', async () => {
      const mockModels = [
        { model_name: 'gpt-4o', litellm_params: { model: 'openai/gpt-4o' } },
      ]
      vi.spyOn(client as any, 'httpRequest').mockResolvedValue(JSON.stringify({ data: mockModels }))

      const models = await client.listModels()

      expect(models).toHaveLength(1)
      expect(models[0].model_name).toBe('gpt-4o')
    })
  })

  describe('generateKey', () => {
    it('should generate key with models', async () => {
      const params: LiteLLMGenerateKeyParams = {
        models: ['gpt-4o'],
        key_alias: 'test-service',
      }

      vi.spyOn(client as any, 'httpRequest').mockResolvedValue(
        JSON.stringify({ key: 'sk-generated-key', models: ['gpt-4o'] })
      )

      const result = await client.generateKey(params)

      expect(result.key).toBe('sk-generated-key')
      expect((client as any).httpRequest).toHaveBeenCalledWith(
        '/key/generate',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(params),
        })
      )
    })
  })

  describe('deleteKey', () => {
    it('should call /key/delete endpoint', async () => {
      vi.spyOn(client as any, 'httpRequest').mockResolvedValue(JSON.stringify({ success: true }))

      await client.deleteKey('sk-test-key')

      expect((client as any).httpRequest).toHaveBeenCalledWith(
        '/key/delete',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ keys: ['sk-test-key'] }),
        })
      )
    })
  })

  describe('checkHealth', () => {
    it('should return healthy on success', async () => {
      vi.spyOn(client as any, 'httpRequest').mockResolvedValue(JSON.stringify({ status: 'healthy' }))

      const result = await client.checkHealth()

      expect(result.success).toBe(true)
    })

    it('should return unhealthy on failure', async () => {
      vi.spyOn(client as any, 'httpRequest').mockRejectedValue(new Error('Connection refused'))

      const result = await client.checkHealth()

      expect(result.success).toBe(false)
      expect(result.message).toContain('Connection refused')
    })
  })
})