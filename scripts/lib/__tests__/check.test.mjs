import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let output

beforeEach(() => {
  vi.resetModules()
  output = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function services({ offset = 0, modules = [{ module_id: 'admin-web', port: 19042 }], discoveryFails = false, failures = false } = {}) {
  vi.stubEnv('CRABOT_PORT_OFFSET', String(offset))
  const mm = `http://localhost:${19000 + offset}`
  const web = `http://localhost:${3000 + offset}`
  const admin = modules.find((m) => m.module_id === 'admin-web')
  const fetchImpl = vi.fn(async (url, options = {}) => {
    if (url === `http://127.0.0.1:${19000 + offset}/list_modules` && options.method === 'POST') {
      if (discoveryFails) throw new Error('ECONNREFUSED')
      return Response.json({ success: true, data: { modules } })
    }
    if (url === `${web}/health` && (options.method ?? 'GET') === 'GET') {
      return Response.json({ status: 'healthy' })
    }
    if (url === `${mm}/health` || url === `http://localhost:${admin?.port}/health`) {
      if (options.method !== 'POST') return new Response('', { status: 405 })
      if (failures && url === `${mm}/health`) throw new Error('ECONNREFUSED')
      return Response.json({ success: true, data: { status: 'healthy' } }, { status: failures ? 503 : 200 })
    }
    throw new Error(`Unexpected endpoint: ${url}`)
  })
  vi.stubGlobal('fetch', fetchImpl)
  return fetchImpl
}

function lines() {
  return output.mock.calls.map(([line]) => String(line)).join('\n')
}

describe('crabot check', () => {
  it.each([0, 137])('uses POST RPC health and the MM-assigned Admin port with offset %i', async (offset) => {
    const adminPort = 19442 + offset
    const fetchImpl = services({ offset, modules: [
      { module_id: 'other-admin', module_type: 'admin', port: 19001 + offset },
      { module_id: 'admin-web', module_type: 'admin', port: adminPort },
    ] })

    await import('../../check.mjs')

    for (const url of [
      `http://localhost:${19000 + offset}/health`,
      `http://127.0.0.1:${19000 + offset}/list_modules`,
      `http://localhost:${adminPort}/health`,
    ]) {
      expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }))
    }
    expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith('/list_modules'))).toHaveLength(1)
    expect(fetchImpl.mock.calls.some(([url]) => url === `http://localhost:${19001 + offset}/health`)).toBe(false)
    expect(fetchImpl.mock.calls.some(([url, opts]) => url === `http://localhost:${3000 + offset}/health` && (opts.method ?? 'GET') === 'GET')).toBe(true)
    expect(lines()).toMatch(new RegExp(`Admin \\(RPC\\)\\s+:${adminPort}`))
    expect(lines().match(/\u001b\[32m●/g)).toHaveLength(3)
    expect(lines()).not.toContain('\u001b[31m●')
  })

  it.each([
    { name: 'MM discovery fails', discoveryFails: true },
    { name: 'Admin is missing', modules: [] },
    { name: 'Admin has no port', modules: [{ module_id: 'admin-web' }] },
  ])('does not guess an Admin port when $name', async (options) => {
    const fetchImpl = services(options)

    await import('../../check.mjs')

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([
      'http://127.0.0.1:19000/list_modules', 'http://localhost:19000/health', 'http://localhost:3000/health',
    ]))
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(lines()).toMatch(/\u001b\[31m●\u001b\[0m Admin \(RPC\).*\(port unavailable\)/)
  })

  it('continues reporting HTTP and connection failures', async () => {
    services({ failures: true })

    await import('../../check.mjs')

    expect(lines()).toMatch(/Module Manager\s+:19000\s+\(unreachable\)/)
    expect(lines()).toMatch(/Admin \(RPC\)\s+:19042\s+\(HTTP 503\)/)
    expect(lines().match(/\u001b\[31m●/g)).toHaveLength(2)
    expect(lines().match(/\u001b\[32m●/g)).toHaveLength(1)
  })
})
