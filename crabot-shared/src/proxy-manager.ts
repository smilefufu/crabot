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
  private config: ProxyConfig = { mode: 'system' }
  private cachedHttpsAgent: https.Agent | InstanceType<typeof HttpsProxyAgent> | null = null

  /**
   * 更新代理配置。
   * 立即生效：全局 fetch dispatcher 和 getHttpsAgent() 都会使用新配置。
   */
  updateConfig(config: ProxyConfig): void {
    this.config = config
    this.cachedHttpsAgent = null

    const url = this.resolveProxyUrl(config)
    if (url) {
      setGlobalDispatcher(new ProxyAgent(url))
    } else {
      setGlobalDispatcher(new Agent())
    }
  }

  /**
   * 获取当前代理 URL（用于日志/诊断）
   */
  getProxyUrl(): string | null {
    return this.resolveProxyUrl(this.config)
  }

  /**
   * 获取当前配置
   */
  getConfig(): ProxyConfig {
    return this.config
  }

  /**
   * 获取系统代理 URL（从环境变量读取）
   */
  static resolveSystemProxyUrl(): string | null {
    return process.env.HTTPS_PROXY
      || process.env.HTTP_PROXY
      || process.env.https_proxy
      || process.env.http_proxy
      || null
  }

  /**
   * 获取 HTTPS Agent，供 http.request() 和第三方 SDK 使用。
   * 缓存实例以复用连接池，仅在 updateConfig 时失效。
   */
  getHttpsAgent(): https.Agent | InstanceType<typeof HttpsProxyAgent> {
    if (!this.cachedHttpsAgent) {
      const url = this.resolveProxyUrl(this.config)
      this.cachedHttpsAgent = url
        ? new HttpsProxyAgent(url)
        : new https.Agent()
    }
    return this.cachedHttpsAgent
  }

  private resolveProxyUrl(config: ProxyConfig): string | null {
    switch (config.mode) {
      case 'system':
        return ProxyManager.resolveSystemProxyUrl()
      case 'custom':
        return config.custom_url || null
      case 'none':
        return null
    }
  }
}

/** 进程级单例 */
export const proxyManager = new ProxyManager()
