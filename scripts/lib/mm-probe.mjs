// MM 探活探针。MM 的 RPC 路由是 POST /<method_name>（见 protocol-module-manager.md），
// GET 会被 405 拒掉；响应统一包在 {id, success, data} 信封里。
// 这两点 CLI 侧曾经都搞错过（start -d 用 GET 探 /health 永远超时、
// status 读顶层 data.modules 永远 null），改动前先看 __tests__/mm-probe.test.mjs。

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
export async function probeMmModules(mmPort, fetchImpl = fetch) {
  try {
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
export async function probeMmHealthy(mmPort, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`http://127.0.0.1:${mmPort}/health`, {
      ...POST_OPTS,
      signal: AbortSignal.timeout(1500),
    })
    if (!r.ok) return false
    const body = await r.json()
    return body?.data?.status === 'healthy'
  } catch {
    return false
  }
}
