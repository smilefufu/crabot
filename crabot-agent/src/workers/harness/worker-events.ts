/**
 * WorkerEventLog —— worker 化身事件流:每个 workerDir 一份 events.jsonl,append-only。
 * 读写纪律参照 src/workers/cli-events.ts:坏行跳过不抛,半行(尚无换行符终结,写入未完成)
 * 不消费,留到下次补全后再读。当前是每次全量读(P3 规模足够);若将来量大需要增量读,
 * 再加 cursor 支持。
 *
 * harvestNativeSession 是化身终结时的收尾动作:把 adapter 侧的原生 session 文件(如
 * claude code / codex 自己维护的会话文件)尽力复制进 <workerDir>/native-session/<seq>/,
 * 单个源文件缺失或读取失败只 warn,不影响其它源文件的收割,也不让收割动作本身抛出。
 */

import { promises as fs } from 'fs'
import { join, basename } from 'path'
import { AsyncMutex } from '../async-mutex'

export type HarnessEventKind =
  | 'spawned'
  | 'input_sent'
  | 'input_held'
  | 'state_changed'
  | 'exited'
  | 'killed'
  | 'superseded'
  | 'handoff_started'
  | 'resumed'
  /**
   * P4 Task 4 additive:`queryWorker`(侧问 fork)自己的失败路径——worker 不存在、目标 impl
   * 未注册 adapter、`capabilities().fork` 为 false、`adapter.fork` 抛错——都落这个 kind。
   * `query_worker` 工具是字面 fire-and-forget(见 manager/tools/worker-tools.ts 文件头),
   * 失败不再能在那次调用内回传给 LLM,这是失败留痕的唯一出口(protocol-agent-v3 §10 可观测
   * 性预期),供 `debug-agent.mjs trace`/`onEvent` 订阅方排查。`detail.reason` 取值:
   * 'worker_not_found' | 'no_adapter' | 'capability_not_supported' | 'fork_failed' |
   * 'worker_disappeared'(见 harness.ts queryWorker 注释,理论上不会发生的防御性分支)。
   */
  | 'query_failed'

export interface HarnessEvent {
  readonly ts: string
  readonly kind: HarnessEventKind
  readonly worker_id: string
  readonly seq: number
  readonly detail?: Record<string, unknown>
}

function parseLine(line: string): HarnessEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.ts === 'string' &&
      typeof parsed.kind === 'string' &&
      typeof parsed.worker_id === 'string' &&
      typeof parsed.seq === 'number'
    ) {
      const event: HarnessEvent = {
        ts: parsed.ts,
        kind: parsed.kind,
        worker_id: parsed.worker_id,
        seq: parsed.seq,
      }
      return 'detail' in parsed ? { ...event, detail: parsed.detail } : event
    }
    return null
  } catch {
    return null // 坏行:跳过,不中断
  }
}

export class WorkerEventLog {
  private readonly filePath: string
  private readonly mutex = new AsyncMutex()

  constructor(private readonly workerDir: string) {
    this.filePath = join(workerDir, 'events.jsonl')
  }

  /** 缺省 ts 由调用方注入的 now 提供;未提供时用当前时间兜底(仅作最后手段,优先由调用方注入以保证测试确定性) */
  async append(e: Omit<HarnessEvent, 'ts'> & { ts?: string }): Promise<void> {
    const event: HarnessEvent = { ...e, ts: e.ts ?? new Date().toISOString() }
    const line = JSON.stringify(event) + '\n'
    return this.mutex.run(async () => {
      await fs.mkdir(this.workerDir, { recursive: true })
      await fs.appendFile(this.filePath, line, 'utf-8')
    })
  }

  async readAll(): Promise<HarnessEvent[]> {
    let text: string
    try {
      text = await fs.readFile(this.filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const events: HarnessEvent[] = []
    for (const line of text.split('\n')) {
      const event = parseLine(line)
      if (event) events.push(event)
    }
    return events
  }
}

/** 化身终结时把 adapter 的原生 session 文件收割进 <workerDir>/native-session/<seq>/,失败仅记不抛 */
export async function harvestNativeSession(
  workerDir: string,
  seq: number,
  sourcePaths: readonly string[]
): Promise<void> {
  const targetDir = join(workerDir, 'native-session', String(seq))
  for (const sourcePath of sourcePaths) {
    try {
      await fs.mkdir(targetDir, { recursive: true })
      await fs.copyFile(sourcePath, join(targetDir, basename(sourcePath)))
    } catch (error) {
      console.warn(`[harvestNativeSession] 收割原生 session 文件失败,跳过: ${sourcePath}: ${(error as Error).message}`)
    }
  }
}
