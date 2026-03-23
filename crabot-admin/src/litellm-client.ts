/**
 * LiteLLM 客户端
 *
 * 封装 LiteLLM Management API 调用，用于管理模型和密钥
 */

import http from 'http'
import https from 'https'
import type {
  LiteLLMClientConfig,
  LiteLLMModelConfig,
  LiteLLMModelInfo,
  LiteLLMGenerateKeyParams,
  LiteLLMKeyInfo,
} from './types.js'

/**
 * LiteLLM 健康状态
 */
export interface LiteLLMHealth {
  success: boolean
  message?: string
}

/**
 * LiteLLM Management API 客户端
 */
export class LiteLLMClient {
  private readonly baseUrl: string
  private readonly masterKey: string

  constructor(config: LiteLLMClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.masterKey = config.masterKey
  }

  // ============================================================================
  // 健康检查
  // ============================================================================

  async checkHealth(): Promise<LiteLLMHealth> {
    try {
      const response = await this.httpRequest('/health', { method: 'GET' })
      const data = JSON.parse(response)
      return { success: true, message: data.status }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // ============================================================================
  // 模型管理
  // ============================================================================

  /**
   * 创建模型
   */
  async createModel(config: LiteLLMModelConfig): Promise<void> {
    await this.httpRequest('/model/new', {
      method: 'POST',
      body: JSON.stringify(config),
    })
  }

  /**
   * 删除模型
   */
  async deleteModel(modelName: string): Promise<void> {
    await this.httpRequest('/model/delete', {
      method: 'POST',
      body: JSON.stringify({ model_id: modelName }),
    })
  }

  /**
   * 列出所有模型
   */
  async listModels(): Promise<LiteLLMModelInfo[]> {
    const response = await this.httpRequest('/model/info', {
      method: 'GET',
    })
    const data = JSON.parse(response)
    return data.data || []
  }

  // ============================================================================
  // 密钥管理
  // ============================================================================

  /**
   * 生成访问密钥
   */
  async generateKey(params: LiteLLMGenerateKeyParams): Promise<LiteLLMKeyInfo> {
    const response = await this.httpRequest('/key/generate', {
      method: 'POST',
      body: JSON.stringify(params),
    })
    const data = JSON.parse(response)
    return {
      key: data.key,
      key_alias: params.key_alias,
      models: data.models || params.models,
      max_budget: params.max_budget,
    }
  }

  /**
   * 删除密钥
   */
  async deleteKey(key: string): Promise<void> {
    await this.httpRequest('/key/delete', {
      method: 'POST',
      body: JSON.stringify({ keys: [key] }),
    })
  }

  // ============================================================================
  // HTTP 请求辅助方法
  // ============================================================================

  private httpRequest(
    endpoint: string,
    options: {
      method: string
      body?: string
    }
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = `${this.baseUrl}${endpoint}`
      const urlObj = new URL(url)
      const client = urlObj.protocol === 'https:' ? https : http

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.masterKey}`,
      }

      if (options.body) {
        headers['Content-Length'] = Buffer.byteLength(options.body).toString()
      }

      const req = client.request(
        url,
        {
          method: options.method,
          headers,
        },
        (res: http.IncomingMessage) => {
          let data = ''
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString()
          })
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data)
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`))
            }
          })
        }
      )

      req.on('error', (error) => {
        reject(new Error(`Request failed: ${error.message}`))
      })

      if (options.body) {
        req.write(options.body)
      }

      req.end()
    })
  }
}