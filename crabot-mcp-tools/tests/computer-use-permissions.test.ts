import { afterEach, describe, it, expect, vi } from 'vitest'
import { waitForMacPermissions } from '../src/computer-use/native-driver.js'
afterEach(() => vi.useRealTimers())
const pending = { isError: true, content: [{ type: 'text', text: 'permissions_pending: startup probe is running' }] }
const ready = { structuredContent: { accessibility: true, screen_recording: true }, content: [] }
describe('macOS permission readiness', () => {
  it('waits for startup pending instead of falsely reporting a missing grant', async () => {
    vi.useFakeTimers()
    const callTool = vi.fn().mockResolvedValueOnce(pending).mockResolvedValue(ready)
    const wait = waitForMacPermissions({ callTool } as never, Date.now() + 30000)
    await vi.advanceTimersByTimeAsync(100)
    await wait
    expect(callTool).toHaveBeenCalledTimes(2)
    expect(callTool.mock.calls[0][0].arguments).toEqual({ prompt: false })
  })
  it('keeps a true missing permission distinct from a malformed or refused check', async () => {
    const callTool = vi.fn().mockResolvedValue({ structuredContent: { accessibility: true, screen_recording: false }, content: [] })
    await expect(waitForMacPermissions({ callTool } as never, Date.now() + 30000)).rejects.toThrow('COMPUTER_USE_SCREEN_RECORDING_REQUIRED')
    callTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'permission_denied' }] })
    await expect(waitForMacPermissions({ callTool } as never, Date.now() + 30000)).rejects.toThrow('COMPUTER_USE_PERMISSION_CHECK_FAILED')
  })
  it('uses the startup deadline and never retries a desktop action', async () => {
    vi.useFakeTimers()
    const callTool = vi.fn().mockResolvedValue(pending)
    const wait = waitForMacPermissions({ callTool } as never, Date.now() + 1000)
    const rejection = expect(wait).rejects.toThrow('COMPUTER_USE_PERMISSIONS_PENDING')
    await vi.advanceTimersByTimeAsync(1001)
    await rejection
    expect(callTool.mock.calls.every(([request]) => request.name === 'check_permissions')).toBe(true)
  })
})
