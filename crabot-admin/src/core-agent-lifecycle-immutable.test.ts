import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminModule from './index.js'

describe('Admin core Agent lifecycle delegation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('never resolves or forwards mutable env when starting the builtin core Agent', async () => {
    const subject = Object.create(AdminModule.prototype) as any
    subject.resolveModuleStartEnv = vi.fn(() => { throw new Error('must not resolve mutable core env') })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { status: 'accepted', tracking_id: 'start' } }) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(subject.handleStartModuleAdmin({ module_id: 'crabot-agent' })).resolves.toMatchObject({ tracking_id: 'start' })
    expect(subject.resolveModuleStartEnv).not.toHaveBeenCalled()
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.params).toEqual({ module_id: 'crabot-agent' })
  })

  it('never resolves or forwards mutable env when restarting the builtin core Agent', async () => {
    const subject = Object.create(AdminModule.prototype) as any
    subject.resolveModuleStartEnv = vi.fn(() => { throw new Error('must not resolve mutable core env') })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { status: 'accepted', tracking_id: 'restart' } }) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(subject.handleRestartModuleAdmin({ module_id: 'crabot-agent', force: true })).resolves.toMatchObject({ tracking_id: 'restart' })
    expect(subject.resolveModuleStartEnv).not.toHaveBeenCalled()
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.params).toEqual({ module_id: 'crabot-agent', force: true })
  })
})
