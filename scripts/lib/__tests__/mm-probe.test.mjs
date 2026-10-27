import { describe, it, expect, vi } from 'vitest'
import { parseListModulesResponse, probeMmModules, probeMmHealthy } from '../mm-probe.mjs'

// 真实 MM 响应信封（2026-06-10 对 http://localhost:19000 实测抓取的结构）
const REAL_ENVELOPE = {
  id: '3de850e8-aa02-4ceb-ba63-1a78c7dee738',
  success: true,
  data: {
    modules: [
      { module_id: 'admin-web', module_type: 'admin', status: 'running', pid: 52554, port: 19001 },
      { module_id: 'crabot-agent', module_type: 'agent', status: 'running', pid: 52601, port: 19005 },
    ],
  },
  timestamp: '2026-06-10T07:09:16.016Z',
}

describe('parseListModulesResponse', () => {
  it('解析真实 MM RPC 信封 {success, data: {modules}}（status 误判 bug 的复现）', () => {
    const modules = parseListModulesResponse(REAL_ENVELOPE)
    expect(modules).toHaveLength(2)
    expect(modules[0].module_id).toBe('admin-web')
  })

  it('兼容裸 {modules: [...]} 形态', () => {
    expect(parseListModulesResponse({ modules: [{ module_id: 'x' }] })).toHaveLength(1)
  })

  it('兼容裸数组形态', () => {
    expect(parseListModulesResponse([{ module_id: 'x' }])).toHaveLength(1)
  })

  it('无法识别的形态返回 null', () => {
    expect(parseListModulesResponse({ error: 'whatever' })).toBeNull()
    expect(parseListModulesResponse(null)).toBeNull()
  })
})

describe('probeMmModules', () => {
  it('用 POST 请求 /list_modules 并解出 modules', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => REAL_ENVELOPE,
    })
    const modules = await probeMmModules(19000, fetchImpl)
    expect(modules).toHaveLength(2)
    const [url, opts] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:19000/list_modules')
    expect(opts.method).toBe('POST')
  })

  it('连接失败返回 null', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await probeMmModules(19000, fetchImpl)).toBeNull()
  })
})

describe('probeMmHealthy', () => {
  it('用 POST 请求 /health（GET 会 405——start -d 超时 bug 的复现）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { status: 'healthy' } }),
    })
    expect(await probeMmHealthy(19000, fetchImpl)).toBe(true)
    const [url, opts] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:19000/health')
    expect(opts.method).toBe('POST')
  })

  it('HTTP 非 2xx（如 405 Method not allowed）返回 false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    expect(await probeMmHealthy(19000, fetchImpl)).toBe(false)
  })

  it('MM 报 unhealthy 返回 false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { status: 'unhealthy' } }),
    })
    expect(await probeMmHealthy(19000, fetchImpl)).toBe(false)
  })

  it('连接失败返回 false', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await probeMmHealthy(19000, fetchImpl)).toBe(false)
  })
})
