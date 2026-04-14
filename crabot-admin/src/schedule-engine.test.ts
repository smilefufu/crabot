import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ScheduleEngine } from './schedule-engine.js'
import type { Schedule } from './types.js'

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sched-001',
    name: 'Test Schedule',
    enabled: true,
    trigger: { type: 'interval', seconds: 10 },
    task_template: {
      type: 'background',
      title: 'Test Task',
      priority: 'normal',
      tags: [],
    },
    execution_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('ScheduleEngine', () => {
  let engine: ScheduleEngine
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onTrigger: any

  beforeEach(() => {
    vi.useFakeTimers()
    onTrigger = vi.fn().mockResolvedValue(undefined)
    engine = new ScheduleEngine({ onTrigger })
  })

  afterEach(() => {
    engine.stop()
    vi.useRealTimers()
  })

  // ---- interval ----

  it('fires interval trigger after each period', () => {
    const schedule = makeSchedule()
    engine.add(schedule)

    vi.advanceTimersByTime(10_000)
    expect(onTrigger).toHaveBeenCalledTimes(1)
    expect(onTrigger).toHaveBeenCalledWith(schedule)

    vi.advanceTimersByTime(10_000)
    expect(onTrigger).toHaveBeenCalledTimes(2)
  })

  // ---- once ----

  it('fires once trigger at the scheduled time', () => {
    const futureDate = new Date(Date.now() + 5_000).toISOString()
    const schedule = makeSchedule({
      id: 'sched-once',
      trigger: { type: 'once', execute_at: futureDate },
    })
    engine.add(schedule)

    vi.advanceTimersByTime(4_999)
    expect(onTrigger).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onTrigger).toHaveBeenCalledTimes(1)

    // should not fire again
    vi.advanceTimersByTime(10_000)
    expect(onTrigger).toHaveBeenCalledTimes(1)
  })

  it('fires immediately when once trigger execute_at is in the past', () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString()
    const schedule = makeSchedule({
      id: 'sched-past',
      trigger: { type: 'once', execute_at: pastDate },
    })
    engine.add(schedule)

    // delay is Math.max(0, ...) so fires on next tick (0ms timeout)
    vi.advanceTimersByTime(0)
    expect(onTrigger).toHaveBeenCalledTimes(1)
  })

  // ---- disabled ----

  it('does not create timer for disabled schedule', () => {
    const schedule = makeSchedule({ enabled: false })
    engine.add(schedule)

    vi.advanceTimersByTime(30_000)
    expect(onTrigger).not.toHaveBeenCalled()
  })

  it('startAll skips disabled schedules', () => {
    const enabled = makeSchedule({ id: 'sched-a', enabled: true })
    const disabled = makeSchedule({ id: 'sched-b', enabled: false })
    engine.startAll([enabled, disabled])

    vi.advanceTimersByTime(10_000)
    expect(onTrigger).toHaveBeenCalledTimes(1)
    expect(onTrigger).toHaveBeenCalledWith(enabled)
  })

  // ---- remove ----

  it('stops firing after remove', () => {
    const schedule = makeSchedule()
    engine.add(schedule)

    vi.advanceTimersByTime(10_000)
    expect(onTrigger).toHaveBeenCalledTimes(1)

    engine.remove(schedule.id)

    vi.advanceTimersByTime(20_000)
    expect(onTrigger).toHaveBeenCalledTimes(1)
  })

  // ---- disable / enable ----

  it('disable stops timer, enable restarts it', () => {
    const schedule = makeSchedule()
    engine.add(schedule)

    vi.advanceTimersByTime(10_000)
    expect(onTrigger).toHaveBeenCalledTimes(1)

    engine.disable(schedule.id)
    vi.advanceTimersByTime(20_000)
    expect(onTrigger).toHaveBeenCalledTimes(1)

    engine.enable(schedule.id, schedule)
    vi.advanceTimersByTime(10_000)
    expect(onTrigger).toHaveBeenCalledTimes(2)
  })

  // ---- update ----

  it('update replaces the timer with new config', () => {
    const schedule = makeSchedule()
    engine.add(schedule)

    // original: 10s interval
    vi.advanceTimersByTime(10_000)
    expect(onTrigger).toHaveBeenCalledTimes(1)

    // update to 5s interval
    const updated = makeSchedule({ trigger: { type: 'interval', seconds: 5 } })
    engine.update(schedule.id, updated)

    vi.advanceTimersByTime(5_000)
    expect(onTrigger).toHaveBeenCalledTimes(2)
  })

  // ---- stop ----

  it('stop clears all timers', () => {
    engine.add(makeSchedule({ id: 'sched-x' }))
    engine.add(makeSchedule({ id: 'sched-y' }))

    engine.stop()

    vi.advanceTimersByTime(30_000)
    expect(onTrigger).not.toHaveBeenCalled()
  })

  // ---- triggerNow ----

  it('triggerNow fires immediately without affecting scheduled timer', () => {
    const schedule = makeSchedule()
    engine.add(schedule)

    engine.triggerNow(schedule.id, schedule)

    // triggerNow fires synchronously (the promise is fire-and-forget)
    expect(onTrigger).toHaveBeenCalledTimes(1)

    // scheduled timer still fires at its normal time
    vi.advanceTimersByTime(10_000)
    expect(onTrigger).toHaveBeenCalledTimes(2)
  })

  // ---- error handling ----

  it('does not crash when onTrigger rejects', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTrigger.mockRejectedValueOnce(new Error('boom'))

    const schedule = makeSchedule()
    engine.add(schedule)

    vi.advanceTimersByTime(10_000)
    expect(onTrigger).toHaveBeenCalledTimes(1)

    // engine should still be alive for next tick
    onTrigger.mockResolvedValue(undefined)
    vi.advanceTimersByTime(10_000)
    expect(onTrigger).toHaveBeenCalledTimes(2)

    consoleErrorSpy.mockRestore()
  })
})
