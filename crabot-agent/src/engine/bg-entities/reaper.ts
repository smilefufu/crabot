/**
 * ReadoptReaper — 监视「跨 agent 重启认领回来、且仍存活」的持久 shell。
 *
 * 这些 shell 是上一个 agent 进程 spawn 的 detached 子进程：进程没死（继续写磁盘日志），但本进程
 * 不是它们的父进程，收不到 child.on('exit')。因此需要周期轮询探活；探到退出时读 exitcode sentinel
 * 定真实成败、更新 registry 终态，并回调通知（唤醒挂起的 resumed worker + 持久 bg-notification）。
 *
 * 仅监视 re-adopt 的 shell——本进程自己 spawn 的 shell 由 runShellWithGrace 的 exit 监听处理，不入此表。
 */

import type { BgEntityRegistry } from './registry'
import type { BgShellRegistryRecord } from './types'

export interface ReadoptedExitInfo {
  readonly entity_id: string
  readonly command: string
  readonly status: 'completed' | 'failed' | 'killed'
  readonly exit_code: number
  readonly spawned_by_task_id: string
  readonly owner_friend_id?: string
  /** Optional so legacy persisted entities keep their legacy notification route. */
  readonly worker_id?: string
}

const DEFAULT_POLL_INTERVAL_MS = 5_000

export class ReadoptReaper {
  private readonly watched = new Map<string, BgShellRegistryRecord>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly registry: BgEntityRegistry,
    private readonly onReadoptedExit: (info: ReadoptedExitInfo) => void,
    private readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ) {}

  /** 把 recoverPersistent 返回的 alive shell 加入监视；非空则启动轮询。 */
  watch(records: ReadonlyArray<BgShellRegistryRecord>): void {
    for (const rec of records) this.watched.set(rec.entity_id, rec)
    if (this.watched.size > 0) this.start()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.poll()
    }, this.pollIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 当前监视的实体数（debug / 测试用）。 */
  size(): number {
    return this.watched.size
  }

  private async poll(): Promise<void> {
    for (const [id, rec] of [...this.watched]) {
      let reaped: { status: 'completed' | 'failed' | 'killed'; exit_code: number } | null
      try {
        reaped = await this.registry.reapShellIfDead(rec)
      } catch {
        continue // 本轮探测失败，下轮再试
      }
      if (!reaped) continue
      this.watched.delete(id)
      try {
        this.onReadoptedExit({
          entity_id: rec.entity_id,
          command: rec.command,
          status: reaped.status,
          exit_code: reaped.exit_code,
          spawned_by_task_id: rec.spawned_by_task_id,
          ...(rec.owner.friend_id ? { owner_friend_id: rec.owner.friend_id } : {}),
          ...(rec.owner.worker_id ? { worker_id: rec.owner.worker_id } : {}),
        })
      } catch {
        /* 通知回调抛错不影响其他实体 */
      }
    }
    if (this.watched.size === 0) this.stop()
  }
}
