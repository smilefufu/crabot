import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z, type DesktopHostState } from 'crabot-client'

const ready = (generation = 'b232f3cb-a297-440f-8aba-03af28359e36'): DesktopHostState => ({ phase: 'ready', app_version: 'fixture', platform: 'darwin',
  instance_id: 'a'.repeat(64), generation, admin_url: 'http://127.0.0.1:3000' })
let emit: (value: DesktopHostState) => void
beforeEach(() => {
  vi.resetModules(); localStorage.clear()
  const listeners = new Set<(value: DesktopHostState) => void>()
  emit = value => listeners.forEach(listener => listener(value))
  window.crabotDesktop = { getState: vi.fn(async () => ready()), onStateChanged: (listener: (value: DesktopHostState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    reconnect: vi.fn(async () => ready()) } as any
})
afterEach(() => { delete window.crabotDesktop; vi.unstubAllGlobals() })

it('new host events win over an older initial state snapshot; malformed states never become API authority', async () => {
  let finish!: (value: DesktopHostState) => void
  window.crabotDesktop!.getState = () => new Promise(resolve => { finish = resolve })
  const host = await import('./desktop-host')
  emit(ready())
  finish({ phase: 'stopped', app_version: 'fixture', platform: 'darwin' })
  await Promise.resolve()
  expect(host.getDesktopState()?.phase).toBe('ready')
  emit({ ...ready(), admin_url: 'https://external.example' } as any)
  expect(host.desktopConnection().origin).toBe('http://127.0.0.1:3000')
})

it('desktop HTTP never reads a stored browser token, and generation replacement aborts late responses', async () => {
  const host = await import('./desktop-host')
  await Promise.resolve()
  localStorage.setItem('crabot_admin_token', 'browser-secret')
  localStorage.setItem('crabot_admin_token_expires', '2099-01-01T00:00:00Z')
  let finish!: (value: Response) => void
  const fetcher = vi.fn((_url: RequestInfo | URL, _options?: RequestInit) => new Promise<Response>(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', fetcher)
  const { getWebClient } = await import('./api')
  const old = getWebClient(), signal = host.desktopConnection().signal
  const pending = old.request('/probe', z.unknown())
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('Authorization')).toBe(false)
  emit(ready('b232f3cb-a297-440f-8aba-03af28359e37'))
  await expect(pending).rejects.toMatchObject({ kind: 'cancelled' })
  finish(new Response('{"late":true}'))
  expect(signal.aborted).toBe(true)
  expect(getWebClient()).not.toBe(old)
})

it('disconnect cancels the host lifetime; a same-generation reconnect obtains a fresh client scope', async () => {
  const host = await import('./desktop-host')
  await Promise.resolve()
  const first = host.desktopConnection().signal
  emit({ phase: 'disconnected', app_version: 'fixture', platform: 'darwin' })
  expect(first.aborted).toBe(true)
  expect(() => host.desktopConnection()).toThrow('本机服务尚未连接')
  emit(ready())
  expect(host.desktopConnection().signal).not.toBe(first)
  expect(host.desktopConnection().signal.aborted).toBe(false)
  expect(() => host.adminUrl('//external.example/api/token')).toThrow()
})
