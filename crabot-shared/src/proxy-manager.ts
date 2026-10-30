/**
 * ProxyManager - 全局 HTTP 代理管理
 *
 * 通过 undici setGlobalDispatcher 覆盖 Node.js 全局 fetch 的代理行为，
 * 同时提供 getHttpsAgent() 供 http.request() 和第三方 SDK 使用。
 *
 * 关键设计：内部 RPC（loopback / 私网）始终直连，不读环境代理变量也不走自定义代理。
 * 否则 admin → MM 这种本机回环也会被系统代理拦截，常见症状是 502 Bad Gateway。
 */

import https from 'node:https'
import childProcess from 'node:child_process'
import net from 'node:net'
import { getGlobalDispatcher, setGlobalDispatcher, ProxyAgent, Agent, Dispatcher } from 'undici'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type { ProxyConfig } from './base-protocol.js'

/**
 * 判断 hostname 是否属于回环 / 私网 / 链路本地，这些地址不应走外网代理。
 *
 * 规则：
 * - localhost 字面量
 * - IPv4 loopback (127.0.0.0/8)
 * - IPv4 私网 (10/8、172.16/12、192.168/16)
 * - IPv4 链路本地 (169.254/16)
 * - IPv6 loopback (::1)
 * - IPv6 ULA (fc00::/7)
 * - IPv6 链路本地 (fe80::/10)
 */
export function isLocalHostname(hostname: string): boolean {
  if (!hostname) return false
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return true

  const family = net.isIP(h)
  if (family === 4) {
    const [a, b] = h.split('.').map((n) => parseInt(n, 10))
    if (a === 127) return true
    if (a === 10) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
    return false
  }
  if (family === 6) {
    if (h === '::1') return true
    if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true
    if (h.startsWith('fc') || h.startsWith('fd')) return true
    return false
  }
  return false
}

function extractHostname(origin: unknown): string {
  if (origin instanceof URL) return origin.hostname
  if (typeof origin === 'string') {
    try {
      return new URL(origin).hostname
    } catch {
      return origin
    }
  }
  return ''
}

/**
 * 路由 dispatcher：内部地址走 directAgent，公网走 proxyAgent。
 *
 * undici Dispatcher.destroy 有 4 个重载（含同步 callback / 异步 Promise），
 * 子类直接 override 类型不好对齐；这里只覆盖 dispatch + close 路由所需的 hot path，
 * destroy 走转发由 Promise 包装内部 agent 的销毁。
 */
class RoutingDispatcher extends Dispatcher {
  constructor(
    private readonly directAgent: Dispatcher,
    private readonly proxyAgent: Dispatcher,
  ) {
    super()
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const hostname = extractHostname(options.origin)
    const target = isLocalHostname(hostname) ? this.directAgent : this.proxyAgent
    return target.dispatch(options, handler)
  }

  override async close(): Promise<void> {
    await Promise.all([this.directAgent.close(), this.proxyAgent.close()])
  }

  override destroy(): Promise<void>
  override destroy(err: Error | null): Promise<void>
  override destroy(callback: () => void): void
  override destroy(err: Error | null, callback: () => void): void
  override destroy(
    errOrCallback?: Error | null | (() => void),
    callback?: () => void,
  ): Promise<void> | void {
    const err = typeof errOrCallback === 'function' ? null : (errOrCallback ?? null)
    const cb = typeof errOrCallback === 'function' ? errOrCallback : callback
    const p = Promise.all([
      this.directAgent.destroy(err),
      this.proxyAgent.destroy(err),
    ]).then(() => undefined)
    if (cb) {
      p.then(() => cb()).catch(() => cb())
      return
    }
    return p
  }
}

function readMacOSFixedProxy(): string | null {
  try {
    const output = childProcess.execFileSync('/usr/sbin/scutil', ['--proxy'], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const values: Record<string, string> = {}
    let depth = 0
    for (const line of output.split('\n')) {
      const entry = line.trim()
      if (entry.endsWith('{')) { depth++; continue }
      if (entry === '}') { depth--; continue }
      if (depth !== 1) continue
      const match = entry.match(/^(HTTPSEnable|HTTPSProxy|HTTPSPort|HTTPEnable|HTTPProxy|HTTPPort)\s*:\s*(.*?)\s*$/)
      if (match) values[match[1]] = match[2]
    }
    for (const scheme of ['HTTPS', 'HTTP']) {
      const host = values[scheme + 'Proxy'], port = Number(values[scheme + 'Port'])
      if (values[scheme + 'Enable'] !== '1' || !host || /[\s/@?#\\]/.test(host)
        || !Number.isInteger(port) || port < 1 || port > 65535) continue
      try {
        const hostname = net.isIP(host) === 6 ? `[${host}]` : host
        // The system HTTPS entry is an HTTP CONNECT proxy, not a TLS proxy URL.
        const url = new URL(`http://${hostname}:${port}`)
        return url.origin
      } catch { /* Try the other enabled fixed proxy entry. */ }
    }
  } catch { /* A missing/unavailable system setting must not block local Admin. */ }
  return null
}

export class ProxyManager {
  private static nativeSystemProxyUrl: string | null | undefined
  private config: ProxyConfig = { mode: 'system' }
  private cachedHttpsAgent: https.Agent | InstanceType<typeof HttpsProxyAgent> | null = null

  /**
   * 更新代理配置。
   * 立即生效：全局 fetch dispatcher 和 getHttpsAgent() 都会使用新配置。
   */
  updateConfig(config: ProxyConfig): void {
    this.config = config
    this.cachedHttpsAgent = null
    if (config.mode === 'system') ProxyManager.nativeSystemProxyUrl = undefined

    const url = this.resolveProxyUrl(config)
    if (url) {
      // 公网走代理，loopback / 私网直连
      const direct = new Agent()
      const proxy = new ProxyAgent(url)
      setGlobalDispatcher(new RoutingDispatcher(direct, proxy))
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

  /** 环境变量保持原优先级；macOS 固定系统代理在首次使用/保存 system 时检测。 */
  static resolveSystemProxyUrl(): string | null {
    const inherited = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy
    if (inherited) return inherited
    if (process.platform !== 'darwin') return null
    if (this.nativeSystemProxyUrl === undefined) this.nativeSystemProxyUrl = readMacOSFixedProxy()
    return this.nativeSystemProxyUrl
  }

  /** SDK 自有连接也使用当前网络出口；不捕获旧配置的 dispatcher。 */
  getDispatcher(): Dispatcher {
    return getGlobalDispatcher()
  }

  /**
   * 获取 HTTPS Agent，供 http.request() 和第三方 SDK 使用。
   * 调用方一般是 LLM SDK 直接打外部 API；本机 / 内网回环不应通过此 agent。
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
