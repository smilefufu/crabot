import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputerUseOwner } from '../src/agent/computer-use-owner.js'

const checks = [{ name: 'session_active', status: 'pass' }, { name: 'ax_capability', status: 'pass' }, { name: 'screen_capture_capability', status: 'pass' }]
function fixture() {
  const owner: any = new ComputerUseOwner(() => {}, () => '/unused', async () => {})
  const child = { connected: true, exitCode: 0, disconnect: vi.fn(), send: vi.fn((_message, callback) => callback?.(null)) }
  owner.child = child; owner.endpoint = 'fixture'; owner.ready = true
  return { owner: owner as ComputerUseOwner, internal: owner, child,
    reply: (result: object) => owner.completeDiagnostics(child, child.send.mock.calls.at(-1)![0].id, result) }
}
afterEach(() => { vi.useRealTimers() })
describe('desktop diagnostic snapshots', () => {
  it('returns health immediately while concurrent readers share one slow probe', async () => {
    vi.useFakeTimers()
    const { owner, child, reply } = fixture()
    let first: unknown
    void owner.diagnostics().then(value => { first = value })
    await Promise.resolve()
    expect(first).toMatchObject({ state: 'ready', reason: 'COMPUTER_USE_DIAGNOSTICS_PENDING' })
    await owner.diagnostics(); expect(child.send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4000); reply({ checks })
    expect(await owner.diagnostics()).toMatchObject({ checks, checks_at: new Date().toISOString() })
  })
  it('retains the dated last report during refresh and clears it after a timeout', async () => {
    vi.useFakeTimers()
    const { owner, reply } = fixture()
    await owner.diagnostics(); reply({ checks })
    const at = new Date().toISOString()
    await vi.advanceTimersByTimeAsync(2000)
    expect(await owner.diagnostics()).toMatchObject({ checks, checks_at: at, reason: 'COMPUTER_USE_DIAGNOSTICS_PENDING' })
    await vi.advanceTimersByTimeAsync(6500)
    const result = await owner.diagnostics()
    expect(result.reason).toBe('COMPUTER_USE_DIAGNOSTICS_TIMEOUT')
    expect(result.checks).toBeUndefined(); expect(result.checks_at).toBeUndefined()
  })
  it('ignores an expired reply and permits only one new flight after the cooldown', async () => {
    vi.useFakeTimers()
    const { owner, child, internal } = fixture()
    await owner.diagnostics(); const oldId = child.send.mock.calls[0][0].id
    await vi.advanceTimersByTimeAsync(8500); await owner.diagnostics()
    internal.completeDiagnostics(child, oldId, { checks })
    expect(await owner.diagnostics()).toMatchObject({ reason: 'COMPUTER_USE_DIAGNOSTICS_PENDING' })
    expect(child.send).toHaveBeenCalledTimes(2)
    expect((await owner.diagnostics()).checks).toBeUndefined()
  })
  it('discards reports from a previous generation or configuration', async () => {
    vi.useFakeTimers()
    const { owner, child, internal } = fixture()
    await owner.diagnostics()
    const oldId = child.send.mock.calls[0][0].id
    await owner.prepare([{ name: 'computer-use', command: 'node', args: ['/replacement/crabot-mcp-tools/dist/computer-use/main.js', '--crabot-standard'] }])
    await owner.diagnostics()
    internal.completeDiagnostics(child, oldId, { checks })
    expect((await owner.diagnostics()).checks).toBeUndefined()
    await owner.close()
    internal.completeDiagnostics(child, child.send.mock.calls[1][0].id, { checks })
    expect(await owner.diagnostics()).toEqual({ state: 'uninitialized' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects invalid reports and projects only safe diagnostic fields', async () => {
    vi.useFakeTimers()
    const { owner, reply } = fixture()
    await owner.diagnostics(); reply({ checks: [] })
    expect(await owner.diagnostics()).toMatchObject({ reason: 'COMPUTER_USE_DIAGNOSTICS_INVALID' })
    await vi.advanceTimersByTimeAsync(2000); await owner.diagnostics()
    reply({ checks: checks.map(check => ({ ...check, reason: 'secret', message: 'private', data: { error_detail: 'private' } })) })
    expect((await owner.diagnostics()).checks).toEqual(checks)
    expect(JSON.stringify(await owner.diagnostics())).not.toMatch(/secret|private|error_detail/)
  })
})
