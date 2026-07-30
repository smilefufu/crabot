/**
 * LedgerStore —— worker 台账存储(protocol-agent-v3 §7):每 DialogObjectId 一个 JSON 文件,
 * 一把互斥锁保读-改-写原子性,tmp+rename 保落盘原子性(参照 src/workers/meta-store.ts 的写法)。
 *
 * 索引语义:内存维护 worker_id → DialogObjectId 的查找索引,首次访问时扫描目录建索引(幂等)。
 * findWorker 未命中索引时会重扫一次目录再判,用于兜底外部进程写入台账文件的场景。
 */

import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { AsyncMutex } from '../async-mutex'
import type { DialogObjectId, LedgerWorker, WorkerLedger } from './ledger-types'

const FILE_SUFFIX = '.json'

/**
 * 段编码:把 [A-Za-z0-9_-] 之外的字符转成 %XX(UTF-8 字节),确保无歧义且可逆。
 * 导出以供其它需要"任意字符串 → 合法文件/目录名"的存储复用(如 manager/session-store.ts
 * 编码 ManagerKey),避免各处重复实现同一方案。
 */
export function encodeSegment(s: string): string {
  return encodeURIComponent(s).replace(
    /[.!~*'()]/g,
    (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
  )
}

export function decodeSegment(s: string): string {
  return decodeURIComponent(s)
}

/** DialogObjectId → 台账文件名(导出以支持双向可逆测试与目录扫描) */
export function dialogObjectIdToFilename(id: DialogObjectId): string {
  return `${encodeSegment(id)}${FILE_SUFFIX}`
}

/** 台账文件名 → DialogObjectId;不是本 store 产出的文件名(不认识的前缀/编码)返回 undefined */
export function filenameToDialogObjectId(filename: string): DialogObjectId | undefined {
  if (!filename.endsWith(FILE_SUFFIX)) return undefined
  const stem = filename.slice(0, -FILE_SUFFIX.length)
  let decoded: string
  try {
    decoded = decodeSegment(stem)
  } catch {
    return undefined
  }
  if (decoded.startsWith('friend:') || decoded.startsWith('group:')) {
    return decoded as DialogObjectId
  }
  return undefined
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmpPath = join(dirname(path), `.tmp-${randomUUID()}${FILE_SUFFIX}`)
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmpPath, path)
}

export class LedgerStore {
  private readonly ledgersDir: string
  private readonly mutexes = new Map<DialogObjectId, AsyncMutex>()
  private workerIndex = new Map<string, DialogObjectId>()
  private initPromise: Promise<void> | undefined

  constructor(ledgersDir: string) {
    this.ledgersDir = ledgersDir
  }

  /** 首次访问时扫描目录建 worker_id → dialog_object_id 内存索引;幂等(重复调用共享同一次扫描) */
  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.scanAndBuildIndex()
    }
    await this.initPromise
  }

  async getLedger(id: DialogObjectId): Promise<WorkerLedger> {
    await this.init()
    return this.readLedgerFileStrict(id)
  }

  async listWorkers(id: DialogObjectId): Promise<LedgerWorker[]> {
    const ledger = await this.getLedger(id)
    return ledger.workers
  }

  /** 跨对话对象按 worker_id 查;索引未命中时重扫一次目录再判 */
  async findWorker(
    workerId: string
  ): Promise<{ dialogObjectId: DialogObjectId; worker: LedgerWorker } | undefined> {
    await this.init()
    let id = this.workerIndex.get(workerId)
    if (!id) {
      await this.scanAndBuildIndex()
      id = this.workerIndex.get(workerId)
      if (!id) return undefined
    }
    const ledger = await this.readLedgerFileStrict(id)
    const worker = ledger.workers.find((w) => w.worker_id === workerId)
    if (!worker) return undefined
    return { dialogObjectId: id, worker }
  }

  /** 读-改-写在该对话对象的互斥锁内完成;mutator 返回 undefined 表示放弃写入 */
  async upsertWorker(
    id: DialogObjectId,
    workerId: string,
    mutator: (prev: LedgerWorker | undefined) => LedgerWorker | undefined
  ): Promise<LedgerWorker | undefined> {
    await this.init()
    const mutex = this.getMutex(id)
    return mutex.run(async () => {
      const ledger = await this.readLedgerFileStrict(id)
      const idx = ledger.workers.findIndex((w) => w.worker_id === workerId)
      const prev = idx >= 0 ? ledger.workers[idx] : undefined
      const next = mutator(prev)
      if (next === undefined) return undefined

      if (idx >= 0) {
        ledger.workers[idx] = next
      } else {
        ledger.workers.push(next)
      }
      await writeJsonAtomic(this.pathFor(id), ledger)
      this.workerIndex.set(workerId, id)
      return next
    })
  }

  /**
   * 全量枚举所有对话对象下的 worker(跨 dialog_object_id)。listWorkers/findWorker 都是
   * 针对单个已知对话对象或已知 worker_id 的查找,不满足"扫描整个台账存储"的场景(如
   * Task 9 崩溃恢复对账 reconcileOnStartup 需要巡检所有对话对象下的非终态 worker)——
   * 复用 init() 建好的 worker_id → dialog_object_id 索引拿到全部 dialog_object_id,
   * 再逐个对话对象读一次台账文件拼起来。只读,不新增任何写路径。
   */
  async listAllWorkers(): Promise<Array<{ dialogObjectId: DialogObjectId; worker: LedgerWorker }>> {
    await this.init()
    const dialogIds = new Set(this.workerIndex.values())
    const result: Array<{ dialogObjectId: DialogObjectId; worker: LedgerWorker }> = []
    for (const dialogObjectId of dialogIds) {
      const ledger = await this.readLedgerFileStrict(dialogObjectId)
      for (const worker of ledger.workers) {
        result.push({ dialogObjectId, worker })
      }
    }
    return result
  }

  private getMutex(id: DialogObjectId): AsyncMutex {
    let mutex = this.mutexes.get(id)
    if (!mutex) {
      mutex = new AsyncMutex()
      this.mutexes.set(id, mutex)
    }
    return mutex
  }

  private pathFor(id: DialogObjectId): string {
    return join(this.ledgersDir, dialogObjectIdToFilename(id))
  }

  /**
   * 读取台账文件。不存在返回空壳 { dialog_object_id, workers: [] }(不建文件)。
   * JSON 内容损坏则抛明确错误——这与 init() 扫描时"跳过并 warn"的语义不同:
   * getLedger/upsertWorker 是针对单个已知对话对象的读,坏文件如果静默当空,
   * 后续写入会用空壳覆盖用户原有数据,所以必须显式失败。
   */
  private async readLedgerFileStrict(id: DialogObjectId): Promise<WorkerLedger> {
    const filePath = this.pathFor(id)
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { dialog_object_id: id, workers: [] }
      }
      throw err
    }
    try {
      return JSON.parse(raw) as WorkerLedger
    } catch (err) {
      throw new Error(
        `[LedgerStore] 台账文件损坏(非法 JSON),拒绝当作空壳处理: ${filePath}: ${(err as Error).message}`
      )
    }
  }

  /**
   * 扫描目录建索引。与 readLedgerFileStrict 语义不同:坏文件在这里只跳过并 console.warn,
   * 不让一个坏文件毁掉整个索引(索引只是查找加速手段,允许对损坏对话对象暂时缺失)。
   */
  private async scanAndBuildIndex(): Promise<void> {
    await fs.mkdir(this.ledgersDir, { recursive: true })
    const entries = await fs.readdir(this.ledgersDir)
    const newIndex = new Map<string, DialogObjectId>()

    for (const entry of entries) {
      const id = filenameToDialogObjectId(entry)
      if (!id) continue

      let raw: string
      try {
        raw = await fs.readFile(join(this.ledgersDir, entry), 'utf-8')
      } catch (err) {
        console.warn(`[LedgerStore] 扫描时读取台账文件失败,跳过: ${entry}: ${(err as Error).message}`)
        continue
      }

      let ledger: WorkerLedger
      try {
        ledger = JSON.parse(raw) as WorkerLedger
      } catch (err) {
        console.warn(`[LedgerStore] 扫描时发现损坏的台账文件(非法 JSON),跳过: ${entry}: ${(err as Error).message}`)
        continue
      }

      for (const worker of ledger.workers ?? []) {
        newIndex.set(worker.worker_id, id)
      }
    }

    this.workerIndex = newIndex
  }
}
