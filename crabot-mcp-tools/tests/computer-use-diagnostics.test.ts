import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputerUseCoordinator } from '../src/computer-use/coordinator.js'
import type { NativeDriver } from '../src/computer-use/types.js'

const checks = [
  { name: 'session_active', status: 'pass' },
  { name: 'ax_capability', status: 'pass' },
  { name: 'screen_capture_capability', status: 'pass' },
]
const report = (entries = checks) => ({ content: [], structuredContent: { schema_version: '1', checks: entries } })
afterEach(() => { vi.useRealTimers() })
describe('bounded native desktop diagnostics', () => {
  it('allows the pinned Windows four-second probe to finish', async () => {
    vi.useFakeTimers()
    const call = vi.fn(async (_name, _args, signal: AbortSignal) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(report()), 4000)
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
    }))
    const coordinator = new ComputerUseCoordinator({ call } as unknown as NativeDriver, async () => true)
    const pending = coordinator.diagnostics()
    const result = expect(pending).resolves.toEqual({ checks })
    await vi.advanceTimersByTimeAsync(4000)
    await result
  })
  it('classifies fixed native failures without disclosing their raw details', async () => {
    const entries = checks.map(check => check.name === 'ax_capability' ? { ...check, status: 'fail',
      data: { error_detail: 'UI Automation desktop enumeration exceeded 4000ms; a UIA provider may be hung.' }, hint: 'private hint' } : check)
    const coordinator = new ComputerUseCoordinator({ call: async () => report(entries) } as unknown as NativeDriver, async () => true)
    const result = await coordinator.diagnostics()
    expect(result).toEqual({ checks: [checks[0], { name: 'ax_capability', status: 'fail', reason: 'COMPUTER_USE_AX_TIMEOUT' }, checks[2]] })
    expect(JSON.stringify(result)).not.toMatch(/error_detail|private hint|provider/)
  })
  it.each([
    ['ax_capability', 'UI Automation is busy with an earlier timed-out provider call; try again later', 'COMPUTER_USE_AX_BUSY'],
    ['ax_capability', 'unknown private error', 'COMPUTER_USE_AX_UNAVAILABLE'],
    ['session_active', 'unknown private error', 'COMPUTER_USE_SESSION_UNAVAILABLE'],
    ['screen_capture_capability', 'unknown private error', 'COMPUTER_USE_SCREEN_CAPTURE_PREREQUISITE_FAILED'],
  ])('maps %s failures to stable categories', async (name, error_detail, reason) => {
    const entries = checks.map(check => check.name === name ? { ...check, status: 'fail', data: { error_detail } } : check)
    const coordinator = new ComputerUseCoordinator({ call: async () => report(entries) } as unknown as NativeDriver, async () => true)
    expect((await coordinator.diagnostics()).checks?.find(check => check.name === name)).toEqual({ name, status: 'fail', reason })
  })
  it('bounds a driver that ignores cancellation without quarantining or retrying input', async () => {
    vi.useFakeTimers()
    const call = vi.fn(() => new Promise(() => {})), close = vi.fn()
    const coordinator = new ComputerUseCoordinator({ call, close } as unknown as NativeDriver, async () => true)
    const pending = coordinator.diagnostics()
    await vi.advanceTimersByTimeAsync(6000)
    expect(await pending).toEqual({ reason: 'COMPUTER_USE_DIAGNOSTICS_TIMEOUT' })
    expect(call).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled()
  })
  it('does not accept an empty or incomplete native report as valid evidence', async () => {
    const coordinator = new ComputerUseCoordinator({ call: async () => report([]) } as unknown as NativeDriver, async () => true)
    expect(await coordinator.diagnostics()).toEqual({ reason: 'COMPUTER_USE_DIAGNOSTICS_INVALID' })
  })
})
