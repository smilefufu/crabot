import type { ProxyConfig } from './base-protocol.js'

class ProxyManager {
  updateConfig(_config: ProxyConfig): void {}
  getProxyUrl(): string | null { return null }
  getConfig(): ProxyConfig { return { mode: 'system' } }
}

export const proxyManager = new ProxyManager()
