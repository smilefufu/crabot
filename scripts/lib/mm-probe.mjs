// Current instances use their OS-verified private pipe. HTTP remains only for legacy records.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const POST_OPTS = {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
}

/**
 * 从 list_modules 响应里解出模块数组。
 * 标准形态是 {success, data: {modules}}；兼容裸 {modules} / 裸数组。
 * 解不出来返回 null（调用方据此判定"探活失败"）。
 */
export function parseListModulesResponse(body) {
  if (Array.isArray(body)) return body
  if (!body || typeof body !== 'object') return null
  const payload = body.data ?? body
  return Array.isArray(payload?.modules) ? payload.modules : null
}

/**
 * 探 MM 的 list_modules：成功返回模块数组，MM 不可达 / 响应异常返回 null。
 * 一举两得：MM 存活判定 + 模块列表（admin UI 模块管理页同款数据源）。
 */
export async function probeMmModules(mmPort, fetchImpl = fetch, { dataDir } = {}) {
  try {
    if (dataDir) {
      const control = (await import('./runtime-control.cjs')).default
      if (control.hasRuntimeControl(dataDir)) return parseListModulesResponse(await control.callRuntimeControl(dataDir,
        { target: mmPort, source: 'cli-probe', method: 'list_modules', params: {} }, { timeoutMs: 2000 }))
      if (!existsSync(join(dataDir, 'mm.pid'))) return null
    }
    const r = await fetchImpl(`http://127.0.0.1:${mmPort}/list_modules`, {
      ...POST_OPTS,
      signal: AbortSignal.timeout(2000),
    })
    if (!r.ok) return null
    return parseListModulesResponse(await r.json())
  } catch {
    return null
  }
}

/**
 * 探 MM 的 /health：仅当 HTTP 2xx 且 data.status === 'healthy' 返回 true。
 */
export async function probeMmHealthy(mmPort, fetchImpl = fetch, options = {}) {
  return await probeHealthStatus(mmPort, fetchImpl, options) === 'healthy'
}

// Common bounded health RPC only. Callers separately decide whether a degraded
// management process is operational; this grants no model/business admission.
export async function probeHealthStatus(port, fetchImpl = fetch, { dataDir } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  try {
    if (dataDir) {
      const control = (await import('./runtime-control.cjs')).default
      if (control.hasRuntimeControl(dataDir)) {
        const body = await control.callRuntimeControl(dataDir, { target: port, source: 'cli-probe', method: 'health', params: {} }, { timeoutMs: 1500 })
        return ['healthy', 'degraded', 'unhealthy'].includes(body?.status) ? body.status : null
      }
      if (!existsSync(join(dataDir, 'mm.pid'))) return null
    }
    const r = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      ...POST_OPTS,
      signal: AbortSignal.timeout(1500),
    })
    if (!r.ok) return null
    const body = await r.json(), status = body?.data?.status
    return body?.success === true && ['healthy', 'degraded', 'unhealthy'].includes(status) ? status : null
  } catch { return null }
}
