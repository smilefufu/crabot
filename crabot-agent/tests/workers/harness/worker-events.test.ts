import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WorkerEventLog, harvestNativeSession } from '../../../src/workers/harness/worker-events'
import type { HarnessEvent } from '../../../src/workers/harness/worker-events'

describe('WorkerEventLog', () => {
  let dir: string
  let workerDir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'worker-events-test-'))
    workerDir = join(dir, 'worker-1')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('append 后 readAll 能原样往返读回', async () => {
    const log = new WorkerEventLog(workerDir)
    await log.append({ kind: 'lifecycle_changed', worker_id: 'w-1', seq: 0, ts: '2026-01-01T00:00:00Z' })
    await log.append({ kind: 'state_changed', worker_id: 'w-1', seq: 0, detail: { from: 'idle', to: 'running' } })

    const events: HarnessEvent[] = await log.readAll()
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ kind: 'lifecycle_changed', worker_id: 'w-1', seq: 0, ts: '2026-01-01T00:00:00Z' })
    expect(events[1].kind).toBe('state_changed')
    expect(events[1].detail).toEqual({ from: 'idle', to: 'running' })
    expect(typeof events[1].ts).toBe('string')
  })

  it('未传 ts 时缺省用当前时间兜底', async () => {
    const log = new WorkerEventLog(workerDir)
    const before = Date.now()
    await log.append({ kind: 'input_sent', worker_id: 'w-1', seq: 0 })
    const after = Date.now()

    const events = await log.readAll()
    expect(events).toHaveLength(1)
    const ts = Date.parse(events[0].ts)
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('目录不存在时 append 自动创建', async () => {
    const nested = join(dir, 'a', 'b', 'worker-x')
    const log = new WorkerEventLog(nested)
    await log.append({ kind: 'lifecycle_changed', worker_id: 'w-x', seq: 0 })

    const stat = await fs.stat(join(nested, 'events.jsonl'))
    expect(stat.isFile()).toBe(true)
  })

  it('readAll 对不存在的文件返回空数组', async () => {
    const log = new WorkerEventLog(workerDir)
    expect(await log.readAll()).toEqual([])
  })

  it('readAll 跳过坏行,保留好行', async () => {
    await fs.mkdir(workerDir, { recursive: true })
    await fs.writeFile(
      join(workerDir, 'events.jsonl'),
      [
        'not json at all',
        '{"ts":"2026-01-01T00:00:00Z","kind":"spawned","worker_id":"w-1","seq":0}',
        '{broken json',
      ].join('\n') + '\n',
      'utf-8'
    )
    const log = new WorkerEventLog(workerDir)
    const events = await log.readAll()
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('spawned')
  })

  it('半行(无换行符终结)不被消费,补全后可读', async () => {
    const log = new WorkerEventLog(workerDir)
    await fs.mkdir(workerDir, { recursive: true })
    const filePath = join(workerDir, 'events.jsonl')

    // 写入一条半行:没有结尾换行符,模拟并发写入过程中被读到
    await fs.writeFile(filePath, '{"ts":"2026-01-01T00:00:00Z","kind":"exi', 'utf-8')
    expect(await log.readAll()).toEqual([])

    // 补全该行
    await fs.appendFile(filePath, 'ted","worker_id":"w-1","seq":0}\n', 'utf-8')
    const events = await log.readAll()
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('exited')
  })

  it('并发 append 不交错,行数与内容完整', async () => {
    const log = new WorkerEventLog(workerDir)
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        log.append({ kind: 'input_sent', worker_id: 'w-1', seq: i, detail: { text_len: i } })
      )
    )
    const events = await log.readAll()
    expect(events).toHaveLength(20)
    const seqs = events.map((e) => e.seq).sort((a, b) => a - b)
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })
})

describe('harvestNativeSession', () => {
  let dir: string
  let workerDir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'harvest-native-session-test-'))
    workerDir = join(dir, 'worker-1')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('把源文件复制到 native-session/<seq>/<basename>', async () => {
    const srcDir = await fs.mkdtemp(join(tmpdir(), 'harvest-src-'))
    const srcPath = join(srcDir, 'session.json')
    await fs.writeFile(srcPath, '{"session":"data"}', 'utf-8')

    await harvestNativeSession(workerDir, 3, [srcPath])

    const dstPath = join(workerDir, 'native-session', '3', 'session.json')
    const content = await fs.readFile(dstPath, 'utf-8')
    expect(content).toBe('{"session":"data"}')

    await fs.rm(srcDir, { recursive: true, force: true })
  })

  it('源文件不存在时仅 warn,不抛出', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      harvestNativeSession(workerDir, 1, [join(dir, 'does-not-exist.json')])
    ).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('目标文件已存在则覆盖', async () => {
    const srcDir = await fs.mkdtemp(join(tmpdir(), 'harvest-src-'))
    const srcPath = join(srcDir, 'session.json')

    const targetDir = join(workerDir, 'native-session', '5')
    await fs.mkdir(targetDir, { recursive: true })
    await fs.writeFile(join(targetDir, 'session.json'), 'old content', 'utf-8')

    await fs.writeFile(srcPath, 'new content', 'utf-8')
    await harvestNativeSession(workerDir, 5, [srcPath])

    const content = await fs.readFile(join(targetDir, 'session.json'), 'utf-8')
    expect(content).toBe('new content')

    await fs.rm(srcDir, { recursive: true, force: true })
  })
})
