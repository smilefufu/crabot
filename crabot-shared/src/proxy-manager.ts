/**
 * ProxyManager - 全局 HTTP 代理管理
 *
 * 通过 undici setGlobalDispatcher 覆盖 Node.js 全局 fetch 的代理行为，
 * 同时提供 getHttpsAgent() 供 http.request() 和第三方 SDK 使用。
 */

import https from 'node:https'
import { setGlobalDispatcher, ProxyAgent, Agent } from 'undici'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type { ProxyConfig } from './base-protocol.js'

export class ProxyManager {
  private proxyUrl: string | null = null
  private config: ProxyConfig = { mode: 'system' }

  /**
   * 更新代理配置。
   * 立即生效：全局 fetch dispatcher 和 getHttpsAgent() 都会使用新配置。
   */
  updateConfig(config: ProxyConfig): void {
    this.config = config
    this.proxyUrl = this.resolveProxyUrl(config)

    if (this.proxyUrl) {
      setGlobalDispatcher(new ProxyAgent(this.proxyUrl))
    } else {
      setGlobalDispatcher(new Agent())
    }
  }

  /**
   * 获取当前代理 URL（用于日志/诊断）
   */
  getProxyUrl(): string | null {
    return this.proxyUrl
  }

  /**
   * 获取当前配置
   */
  getConfig(): ProxyConfig {
    return this.config
  }

  /**
   * 获取 HTTPS Agent，供 http.request() 和第三方 SDK（如 @anthropic-ai/sdk）使用。
   * 每次调用返回新实例，确保使用最新的代理配置。
   */
  getHttpsAgent(): https.Agent | InstanceType<typeof HttpsProxyAgent> {
    if (this.proxyUrl) {
      return new HttpsProxyAgent(this.proxyUrl)
    }
    return new https.Agent()
  }

  /**
   * 解析代理 URL
   */
  private resolveProxyUrl(config: ProxyConfig): string | null {
    switch (config.mode) {
      case 'system':
        return process.env.HTTPS_PROXY
          || process.env.HTTP_PROXY
          || process.env.https_proxy
          || process.env.http_proxy
          || null
      case 'custom':
        return config.custom_url || null
      case 'none':
        return null
    }
  }
}

/** 进程级单例 */
export const proxyManager = new ProxyManager()
