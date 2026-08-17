import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SUPERVISOR_FORCE_TIMEOUT_MS,
  createSupervisorShutdownController,
} from '../supervisor-shutdown.mjs'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function makeController() {
  const mm = { pid: 1234, kill: vi.fn() }
  const cleanup = vi.fn()
  const log = vi.fn()
  const controller = createSupervisorShutdownController({ mm, cleanup, log })
  return { mm, cleanup, log, controller }
}

describe('supervisor shutdown', () => {
  it('forwards SIGTERM immediately but waits for the MM window and margin before SIGKILL', () => {
    vi.useFakeTimers()
    const { mm, cleanup, controller } = makeController()

    controller.handleSignal('SIGTERM')

    expect(mm.kill).toHaveBeenCalledWith('SIGTERM')
    vi.advanceTimersByTime(SUPERVISOR_FORCE_TIMEOUT_MS - 1)
    expect(mm.kill).not.toHaveBeenCalledWith('SIGKILL')
    expect(cleanup).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(mm.kill).toHaveBeenCalledWith('SIGKILL')
    expect(cleanup).toHaveBeenCalledWith(1)
  })

  it('shares one force timer across repeated signals', () => {
    vi.useFakeTimers()
    const { mm, controller } = makeController()

    controller.handleSignal('SIGTERM')
    controller.handleSignal('SIGINT')

    expect(mm.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('cancels the force timer when MM exits normally', () => {
    vi.useFakeTimers()
    const { mm, cleanup, controller } = makeController()
    controller.handleSignal('SIGTERM')

    controller.handleMmExit(0)
    vi.advanceTimersByTime(SUPERVISOR_FORCE_TIMEOUT_MS)

    expect(mm.kill).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledWith(0)
  })
})
