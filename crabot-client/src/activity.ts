import { z } from 'zod'
import type { HttpClient, RequestOptions } from './http.js'

// Read projections of protocol-agent-v3 §8.3/§8.4. This check never mutates
// execution, consumes inbound messages, or treats nonterminal history as work.
const Count = z.number().int().nonnegative()
const Workers = z.object({ total_running: Count, total_queued: Count })
const Managers = z.object({
  items: z.array(z.object({ manager_key: z.string().min(1), execution_status: z.enum(['running', 'idle', 'unknown']) })),
  pagination: z.object({ page: Count.min(1), page_size: Count.min(1), total_items: Count, total_pages: Count }),
})
const Inbound = z.object({ manager_key: z.string().min(1), snapshot_at: z.iso.datetime(),
  items: z.array(z.object({ platform_message_id: z.string().min(1), status: z.enum(['queued', 'processing']) })) })

export type ActivityCheck = 'idle' | 'active' | 'unknown'
export class ActivityClient {
  constructor(private readonly http: HttpClient) {}
  async read(options: Pick<RequestOptions, 'signal'> = {}): Promise<ActivityCheck> {
    const lifetime = new AbortController(), abort = () => lifetime.abort()
    const timer = setTimeout(abort, 12_000)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    const request = { method: 'GET', timeoutMs: 5000, signal: lifetime.signal }
    let active = false, unknown = false
    try {
      const workers = () => this.http.request('/agent/workers?page=1&page_size=1', Workers, request)
      const before = await workers()
      active = before.total_running + before.total_queued > 0
      const keys = new Set<string>()
      let total: number | undefined
      for (let page = 1; ; page++) {
        if (page > 100) return 'unknown'
        const result = await this.http.request(`/agent/managers?page=${page}&page_size=100`, Managers, request)
        const paging = result.pagination
        if (paging.page !== page || paging.page_size !== 100 || total !== undefined && total !== paging.total_items
          || paging.total_pages !== Math.ceil(paging.total_items / 100)
          || result.items.length !== Math.min(100, Math.max(0, paging.total_items - (page - 1) * 100))) return 'unknown'
        total = paging.total_items
        for (const item of result.items) {
          if (keys.has(item.manager_key)) return 'unknown'
          keys.add(item.manager_key)
          active ||= item.execution_status === 'running'
          unknown ||= item.execution_status === 'unknown'
        }
        // Bound concurrent reads without creating a second business cache.
        for (let offset = 0; offset < result.items.length; offset += 8) {
          const inbound = await Promise.all(result.items.slice(offset, offset + 8).map(async item => {
            const value = await this.http.request(`/agent/managers/${encodeURIComponent(item.manager_key)}/inbound-status`, Inbound, request)
            if (value.manager_key !== item.manager_key) throw new Error('Manager changed')
            return value.items.length > 0
          }))
          active ||= inbound.some(Boolean)
        }
        if (page >= paging.total_pages) break
      }
      const after = await workers()
      active ||= after.total_running + after.total_queued > 0
      if (lifetime.signal.aborted) return 'unknown'
      return active ? 'active' : unknown ? 'unknown' : 'idle'
    } catch { return 'unknown' }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
  }
}
