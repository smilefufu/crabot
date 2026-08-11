/**
 * ManagerSessionStore —— manager loop 会话状态持久化(protocol-agent-v3 §4):
 * 每 ManagerKey 一个目录,state.json 存对话历史/摘要,episodes/<episodeId>.jsonl 存
 * in-flight 诊断日志。参照 src/workers/harness/ledger-store.ts 的写法:tmp+rename 保
 * 落盘原子性,一把互斥锁保读-改-写/并发写安全。
 *
 * 目录名编码复用 ledger-store 的 encodeSegment/decodeSegment（通用段编码），处理
 * ManagerKey 里的 `::` 与其它非法字符。
 */

import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { AsyncMutex } from '../workers/async-mutex'
import { encodeSegment } from '../workers/harness/ledger-store'
import type { ManagerKey, ManagerSessionState } from './types'
import type { EngineMessage } from '../engine/index.js'

const STATE_FILE = 'state.json'
const EPISODES_DIR = 'episodes'

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmpPath = join(dirname(path), `.tmp-${randomUUID()}.json`)
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmpPath, path)
}

export class ManagerSessionStore {
  private readonly rootDir: string
  private readonly mutexes = new Map<ManagerKey, AsyncMutex>()

  constructor(rootDir: string) {
    this.rootDir = rootDir
  }

  /** 不存在的 key 返回空态,不建目录;坏 JSON 抛明确错误(不静默当空,否则会覆盖历史) */
  async load(key: ManagerKey): Promise<ManagerSessionState> {
    const statePath = this.statePathFor(key)
    let raw: string
    try {
      raw = await fs.readFile(statePath, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { key, recent: [], foldedCount: 0 }
      }
      throw err
    }
    try {
      return JSON.parse(raw) as ManagerSessionState
    } catch (err) {
      throw new Error(
        `[ManagerSessionStore] state.json 损坏(非法 JSON),拒绝当作空状态处理: ${statePath}: ${(err as Error).message}`
      )
    }
  }

  /** 原子写(tmp+rename);每 key 一把 AsyncMutex 保并发 save 不丢 */
  async save(state: ManagerSessionState): Promise<void> {
    const mutex = this.getMutex(state.key)
    await mutex.run(async () => {
      await fs.mkdir(this.dirFor(state.key), { recursive: true })
      await writeJsonAtomic(this.statePathFor(state.key), state)
    })
  }

  /** episode 进行中的消息增量落盘(崩溃后可诊断,不参与 load);目录不存在自动创建 */
  async appendEpisodeLog(
    key: ManagerKey,
    episodeId: string,
    messages: ReadonlyArray<EngineMessage>
  ): Promise<void> {
    if (messages.length === 0) return
    const mutex = this.getMutex(key)
    await mutex.run(async () => {
      const episodesDir = join(this.dirFor(key), EPISODES_DIR)
      await fs.mkdir(episodesDir, { recursive: true })
      const filePath = join(episodesDir, `${episodeId}.jsonl`)
      const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
      await fs.appendFile(filePath, lines, 'utf-8')
    })
  }

  private getMutex(key: ManagerKey): AsyncMutex {
    let mutex = this.mutexes.get(key)
    if (!mutex) {
      mutex = new AsyncMutex()
      this.mutexes.set(key, mutex)
    }
    return mutex
  }

  private dirFor(key: ManagerKey): string {
    return join(this.rootDir, encodeSegment(key))
  }

  private statePathFor(key: ManagerKey): string {
    return join(this.dirFor(key), STATE_FILE)
  }
}
