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
import { writeFileSync, renameSync, unlinkSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { randomUUID, createHash } from 'crypto'
import { isDeepStrictEqual } from 'node:util'
import { AsyncMutex } from '../workers/async-mutex'
import { encodeSegment, decodeSegment } from '../workers/harness/ledger-store'
import type { ManagerKey, ManagerSessionState } from './types'
import { normalizeImageRefs } from './image-vision'
import type { EngineMessage } from '../engine/index.js'
import type { ManagerResumeCheckpoint } from './resume-checkpoint.js'
import type { TimedWakeEnvelope } from './loop.js'
import { assertToolMessageIntegrity, completeToolUseMessages, unknownToolResult } from '../engine/tool-message-integrity.js'

const STATE_FILE = 'state.json'
const EPISODES_DIR = 'episodes'
const CHECKPOINT_FILE = 'running.json'

async function writeJsonAtomic(path: string, data: unknown, mode?: number): Promise<void> {
  const tmpPath = join(dirname(path), `.tmp-${randomUUID()}.json`)
  try {
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode })
    await fs.rename(tmpPath, path)
  } finally {
    await fs.unlink(tmpPath).catch(() => {})
  }
}

export class ManagerSessionStore {
  private readonly rootDir: string
  private readonly mutexes = new Map<ManagerKey, AsyncMutex>()

  constructor(rootDir: string) {
    this.rootDir = rootDir
  }

  /** 不存在的 key 返回空态,不建目录;坏 JSON 抛明确错误(不静默当空,否则会覆盖历史) */
  async load(key: ManagerKey): Promise<ManagerSessionState> {
    return this.getMutex(key).run(() => this.loadUnlocked(key))
  }

  private async loadUnlocked(key: ManagerKey): Promise<ManagerSessionState> {
    const statePath = this.statePathFor(key)
    let raw: Buffer
    try {
      raw = await fs.readFile(statePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { key, recent: [], foldedCount: 0 }
      }
      throw err
    }
    let parsed: ManagerSessionState
    try {
      parsed = JSON.parse(raw.toString('utf-8')) as ManagerSessionState
    } catch (err) {
      throw new Error(
        `[ManagerSessionStore] state.json 损坏(非法 JSON),拒绝当作空状态处理: ${statePath}: ${(err as Error).message}`
      )
    }
    const incomplete = completeToolUseMessages(parsed.recent)
    if (incomplete.some((message, index) => message !== parsed.recent[index])) {
      const checkpoint = await this.loadCheckpoint(key)
      if (checkpoint) completeToolUseMessages(checkpoint.state.recent)
      const recent = completeToolUseMessages(parsed.recent, block => {
        // A matching checkpoint's real result is stronger evidence than a synthetic unknown.
        const recordedCall = checkpoint?.state.recent.flatMap(message => message.role === 'assistant'
          ? message.content.filter(candidate => candidate.type === 'tool_use') : [])
          .find(candidate => candidate.type === 'tool_use' && candidate.id === block.id
            && candidate.name === block.name && isDeepStrictEqual(candidate.input, block.input))
        const recordedResult = recordedCall && checkpoint?.state.recent.flatMap(message =>
          'toolResults' in message ? message.toolResults : []).find(result => result.tool_use_id === block.id)
        if (recordedResult) return recordedResult
        const finished = checkpoint?.tools.find(event => event.type === 'tool_finished'
          && event.toolUseId === block.id && event.name === block.name && isDeepStrictEqual(event.input, block.input))
        return finished?.type === 'tool_finished'
          ? { tool_use_id: block.id, content: finished.output, is_error: finished.isError }
          : unknownToolResult(block)
      })
      const mode = (await fs.stat(statePath)).mode & 0o777
      const backup = `${statePath}.bak-tool-history-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined
      try {
        handle = await fs.open(backup, 'wx', mode & 0o600)
        await handle.writeFile(raw)
        await handle.sync()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      } finally {
        await handle?.close()
      }
      if (!(await fs.readFile(backup)).equals(raw) || ((await fs.stat(backup)).mode & 0o777 & ~mode) !== 0) {
        throw new Error(`[ManagerSessionStore] tool history backup verification failed: ${backup}`)
      }
      parsed = { ...parsed, recent }
      await writeJsonAtomic(statePath, parsed, mode)
    }
    // 旧结构兼容:29a25d08 写出的 imageRefs 是 {message_id, paths},归一化为 images 形态
    return parsed.imageRefs ? { ...parsed, imageRefs: normalizeImageRefs(parsed.imageRefs) } : parsed
  }

  /**
   * 最小 session identity 的原子持久化（P6-A §3.2/§6.2）：
   * 在为某 Manager 创建首个 episode trace 前调用；已存在时不动历史。
   * 保证首个 episode 即使后续步骤失败/进程重启，Manager 仍可从磁盘枚举。
   */
  async ensureSession(key: ManagerKey): Promise<void> {
    const mutex = this.getMutex(key)
    await mutex.run(async () => {
      const statePath = this.statePathFor(key)
      try {
        await fs.access(statePath)
        return
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      await fs.mkdir(this.dirFor(key), { recursive: true })
      const initial: ManagerSessionState = { key, recent: [], foldedCount: 0 }
      await writeJsonAtomic(statePath, initial)
    })
  }

  /**
   * 扫描磁盘目录恢复 ManagerKey 列表（P6-A §7.1）。目录 key 与 state.json.key 不一致时
   * fail loud 隔离（跳过并告警），不猜归属。目录存在但 state.json 缺失/损坏的跳过。
   */
  async listManagerKeys(): Promise<ManagerKey[]> {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(this.rootDir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const keys: ManagerKey[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      let decoded: string
      try {
        decoded = decodeSegment(entry.name)
      } catch (err) {
        console.warn(`[ManagerSessionStore] 无法解码的 manager 目录已隔离: ${entry.name}: ${(err as Error).message}`)
        continue
      }
      try {
        const raw = await fs.readFile(join(this.rootDir, entry.name, STATE_FILE), 'utf-8')
        const parsed = JSON.parse(raw) as ManagerSessionState
        if (parsed.key !== decoded) {
          console.warn(`[ManagerSessionStore] manager 目录与 state.json key 不一致已隔离: dir=${entry.name} key=${parsed.key}`)
          continue
        }
        keys.push(parsed.key)
      } catch (err) {
        console.warn(`[ManagerSessionStore] manager state 缺失/损坏已隔离: ${entry.name}: ${(err as Error).message}`)
      }
    }
    return keys
  }

  /** 原子写(tmp+rename);每 key 一把 AsyncMutex 保并发 save 不丢 */
  async save(state: ManagerSessionState): Promise<void> {
    assertToolMessageIntegrity(state.recent)
    const mutex = this.getMutex(state.key)
    await mutex.run(async () => {
      await fs.mkdir(this.dirFor(state.key), { recursive: true })
      const current = await this.loadUnlocked(state.key)
      await writeJsonAtomic(this.statePathFor(state.key), { ...state, dailyReflection: current.dailyReflection })
    })
  }

  /** Update only the host-owned workflow under the same lock as history writes. */
  async updateDailyReflection(
    key: ManagerKey,
    update: (current: ManagerSessionState['dailyReflection']) => ManagerSessionState['dailyReflection'],
  ): Promise<ManagerSessionState['dailyReflection']> {
    return this.getMutex(key).run(async () => {
      const state = await this.loadUnlocked(key)
      const dailyReflection = update(state.dailyReflection)
      await fs.mkdir(this.dirFor(key), { recursive: true })
      await writeJsonAtomic(this.statePathFor(key), { ...state, dailyReflection })
      return dailyReflection
    })
  }

  /** Same atomic, synchronous turn-boundary flush used by the existing Engine resume path. */
  saveCheckpoint(checkpoint: ManagerResumeCheckpoint): void {
    const target = join(this.dirFor(checkpoint.state.key), CHECKPOINT_FILE)
    const temporary = `${target}.${randomUUID()}.tmp`
    const durableEnvelope = ({ activity_context_receipt: _receipt, ...envelope }: TimedWakeEnvelope): TimedWakeEnvelope => envelope
    try {
      writeFileSync(temporary, JSON.stringify({
        ...checkpoint,
        envelopes: checkpoint.envelopes.map(durableEnvelope),
        pending: checkpoint.pending.map(durableEnvelope),
      }), { encoding: 'utf-8', mode: 0o600 })
      renameSync(temporary, target)
    } finally {
      try { unlinkSync(temporary) } catch { /* rename already removed the temporary file */ }
    }
  }

  async loadCheckpoint(key: ManagerKey): Promise<ManagerResumeCheckpoint | undefined> {
    let raw: string
    try {
      raw = await fs.readFile(join(this.dirFor(key), CHECKPOINT_FILE), 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const checkpoint = JSON.parse(raw) as ManagerResumeCheckpoint
    if (checkpoint.state?.key !== key || typeof checkpoint.episodeId !== 'string'
      || !Array.isArray(checkpoint.state.recent) || !Array.isArray(checkpoint.envelopes)
      || !Number.isInteger(checkpoint.wakeIndex) || checkpoint.wakeIndex < -1 || checkpoint.wakeIndex >= checkpoint.envelopes.length
      || !Array.isArray(checkpoint.pending) || !Array.isArray(checkpoint.turns)
      || !Array.isArray(checkpoint.responses) || !Array.isArray(checkpoint.tools) || !Array.isArray(checkpoint.pendingToolCallIds)
      || !Array.isArray(checkpoint.adminChatClaims) || !Array.isArray(checkpoint.transientMessageIds)
      || !Array.isArray(checkpoint.spawnedWorkerIds) || typeof checkpoint.hasEngineMessages !== 'boolean'
      || !Array.isArray(checkpoint.execution?.successfulSendMessageTargets) || !Array.isArray(checkpoint.execution?.continuedWorkers)) {
      throw new Error(`[ManagerSessionStore] invalid resume checkpoint for ${key}`)
    }
    return checkpoint
  }

  clearCheckpoint(key: ManagerKey, episodeId: string): void {
    const target = join(this.dirFor(key), CHECKPOINT_FILE)
    try {
      const checkpoint = JSON.parse(readFileSync(target, 'utf-8')) as ManagerResumeCheckpoint
      if (checkpoint.episodeId === episodeId) unlinkSync(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[ManagerSessionStore] checkpoint cleanup failed for ${key}:`, error)
      }
    }
  }

  async listCheckpoints(): Promise<ManagerResumeCheckpoint[]> {
    const checkpoints: ManagerResumeCheckpoint[] = []
    for (const key of await this.listManagerKeys()) {
      try {
        const checkpoint = await this.loadCheckpoint(key)
      if (checkpoint) completeToolUseMessages(checkpoint.state.recent)
        if (checkpoint) checkpoints.push(checkpoint)
      } catch (error) {
        console.error(`[ManagerSessionStore] resume checkpoint unavailable for ${key}:`, error)
      }
    }
    return checkpoints
  }

  /** 完整工具组的 episode 消息落盘(崩溃后可诊断,不参与 load);目录不存在自动创建 */
  async appendEpisodeLog(
    key: ManagerKey,
    episodeId: string,
    messages: ReadonlyArray<EngineMessage>
  ): Promise<void> {
    if (messages.length === 0) return
    assertToolMessageIntegrity(messages)
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
