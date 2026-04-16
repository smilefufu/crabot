import { Cron } from 'croner'
import type { Schedule } from './types.js'

type ScheduleId = string

type TimerHandle = { type: 'cron'; cron: Cron } | { type: 'native'; id: ReturnType<typeof setInterval> }

export interface ScheduleEngineOptions {
  onTrigger: (schedule: Schedule) => Promise<{ task_id: string } | void>
}

export class ScheduleEngine {
  private readonly timers = new Map<ScheduleId, TimerHandle>()
  private readonly onTrigger: ScheduleEngineOptions['onTrigger']

  constructor(options: ScheduleEngineOptions) {
    this.onTrigger = options.onTrigger
  }

  /** 批量加载 — Admin 启动时调用 */
  startAll(schedules: Schedule[]): void {
    for (const schedule of schedules) {
      if (schedule.enabled) {
        this.createTimer(schedule)
      }
    }
  }

  /** 停止所有 timer */
  stop(): void {
    for (const [, handle] of this.timers) {
      this.destroyTimer(handle)
    }
    this.timers.clear()
  }

  add(schedule: Schedule): void {
    if (schedule.enabled) {
      this.createTimer(schedule)
    }
  }

  remove(id: ScheduleId): void {
    const handle = this.timers.get(id)
    if (handle) {
      this.destroyTimer(handle)
      this.timers.delete(id)
    }
  }

  update(id: ScheduleId, schedule: Schedule): void {
    this.remove(id)
    this.add(schedule)
  }

  enable(id: ScheduleId, schedule: Schedule): void {
    this.remove(id)
    this.createTimer(schedule)
  }

  disable(id: ScheduleId): void {
    this.remove(id)
  }

  triggerNow(_id: ScheduleId, schedule: Schedule): void {
    this.fireTrigger(schedule)
  }

  private createTimer(schedule: Schedule): void {
    const { trigger } = schedule

    switch (trigger.type) {
      case 'cron': {
        const cron = new Cron(trigger.expression, { timezone: trigger.timezone }, () => {
          this.fireTrigger(schedule)
        })
        this.timers.set(schedule.id, { type: 'cron', cron })
        break
      }
      case 'interval': {
        const id = setInterval(() => {
          this.fireTrigger(schedule)
        }, trigger.seconds * 1000)
        this.timers.set(schedule.id, { type: 'native', id })
        break
      }
      case 'once': {
        const executeTime = new Date(trigger.execute_at).getTime()
        if (Number.isNaN(executeTime)) {
          console.error(`[ScheduleEngine] Invalid execute_at for schedule ${schedule.id}: "${trigger.execute_at}", skipping`)
          break
        }
        const delay = Math.max(0, executeTime - Date.now())
        const id = setTimeout(() => {
          this.fireTrigger(schedule)
        }, delay)
        this.timers.set(schedule.id, { type: 'native', id })
        break
      }
    }
  }

  private destroyTimer(handle: TimerHandle): void {
    if (handle.type === 'cron') {
      handle.cron.stop()
    } else {
      clearInterval(handle.id)
      clearTimeout(handle.id)
    }
  }

  private fireTrigger(schedule: Schedule): void {
    this.onTrigger(schedule).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[ScheduleEngine] Failed to trigger schedule ${schedule.id} (${schedule.name}): ${msg}`)
    })
  }
}
