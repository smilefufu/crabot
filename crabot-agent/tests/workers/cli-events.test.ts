import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CliEventChannel, type CliEvent } from '../../src/workers/cli-events.js'

const execFileAsync = promisify(execFile)

describe('CliEventChannel', () => {
  let tempDir: string
  let filePath: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-events-test-'))
    filePath = path.join(tempDir, 'events-cli.jsonl')
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('hookCommand 产出的命令在 bash 里执行后, readAll 能解析出对应 kind', async () => {
    const channel = new CliEventChannel(filePath)
    const cmd = channel.hookCommand('stop')

    await execFileAsync('/bin/bash', ['-c', `(${cmd}) </dev/null`])

    const events = await channel.readAll()
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('stop')
    expect(events[0].raw).toBeNull()
    expect(typeof events[0].ts).toBe('string')
    // ts should be a valid ISO-8601 UTC timestamp
    expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('hookCommand 对不同 kind 各自产出可解析的独立事件', async () => {
    const channel = new CliEventChannel(filePath)

    await execFileAsync('/bin/bash', ['-c', `(${channel.hookCommand('notification')}) </dev/null`])
    await execFileAsync('/bin/bash', ['-c', `(${channel.hookCommand('session_start')}) </dev/null`])

    const events = await channel.readAll()
    expect(events.map((e) => e.kind)).toEqual(['notification', 'session_start'])
  })

  it('hookCommand keeps a JSON stdin payload as raw', async () => {
    const channel = new CliEventChannel(filePath)
    const payload = '{"notification_type":"permission_prompt","message":"needs permission"}'
    const quoted = `'${payload.replace(/'/g, `'\\''`)}'`
    await execFileAsync('/bin/bash', ['-c', `printf '%s' ${quoted} | (${channel.hookCommand('notification')})`])
    expect((await channel.readAll())[0].raw).toEqual(JSON.parse(payload))
  })

  it('preserves a Stop payload while keeping empty Stop input as legacy raw:null', async () => {
    const channel = new CliEventChannel(filePath)
    const payload = '{"stop_hook_active":true}'
    const quoted = `'${payload.replace(/'/g, `'\\''`)}'`
    await execFileAsync('/bin/bash', ['-c', `printf '%s' ${quoted} | (${channel.hookCommand('stop')})`])
    await execFileAsync('/bin/bash', ['-c', `(${channel.hookCommand('stop')}) </dev/null`])
    expect((await channel.readAll()).map((event) => event.raw)).toEqual([JSON.parse(payload), null])
  })

  it('malformed或截断stdin payload降级为raw:null，不能吞掉整条Stop事件', async () => {
    const channel = new CliEventChannel(filePath)
    for (const payload of ['not json', '{"stop_hook_active":true', '{not-json}', '{"stop_hook_active":}']) {
      const quoted = `'${payload.replace(/'/g, `'\\''`)}'`
      await execFileAsync('/bin/bash', ['-c', `printf '%s' ${quoted} | (${channel.hookCommand('stop')})`])
    }

    const events = await channel.readAll()
    expect(events.map((event) => [event.kind, event.raw])).toEqual([
      ['stop', null],
      ['stop', null],
      ['stop', null],
      ['stop', null],
    ])
  })

  it('readAll 对不存在的文件返回空数组', async () => {
    const channel = new CliEventChannel(path.join(tempDir, 'does-not-exist.jsonl'))
    const events = await channel.readAll()
    expect(events).toEqual([])
  })

  it('readAll 跳过坏行, 保留好行', async () => {
    await fs.writeFile(
      filePath,
      [
        'not json at all',
        '{"ts":"not-hook","kind":"stop","raw":not-json}',
        '{"ts":"2026-01-01T00:00:00Z","kind":"stop","raw":null}',
        '{broken json',
      ].join('\n') + '\n',
      'utf-8',
    )
    const channel = new CliEventChannel(filePath)
    const events = await channel.readAll()
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('stop')
  })

  it('watch 能收到真实 fs 追加驱动的事件(文件此前不存在, 先 watch 后创建)', async () => {
    const channel = new CliEventChannel(filePath)
    const received: CliEvent[] = []

    const stop = channel.watch((e) => received.push(e))
    try {
      // 文件此前不存在;watch 已启动,随后才创建并写入
      await fs.writeFile(filePath, '{"ts":"2026-01-01T00:00:00Z","kind":"session_start","raw":null}\n', 'utf-8')

      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1)
        },
        { timeout: 3000, interval: 50 },
      )
      expect(received[0].kind).toBe('session_start')
    } finally {
      stop()
    }
  })

  it('watch 可从调用方记录的文件位置接续，不重放历史 hook', async () => {
    await fs.writeFile(filePath, '{"ts":"2026-01-01T00:00:00Z","kind":"notification","raw":null}\n', 'utf-8')
    const channel = new CliEventChannel(filePath)
    const offset = await channel.endOffset()
    const received: CliEvent[] = []
    const stop = channel.watch((event) => received.push(event), { offset })
    try {
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(received).toEqual([])

      await fs.appendFile(filePath, '{"ts":"2026-01-01T00:00:01Z","kind":"permission_request","raw":null}\n', 'utf-8')
      await vi.waitFor(() => expect(received.map((event) => event.kind)).toEqual(['permission_request']), {
        timeout: 3000,
        interval: 50,
      })
    } finally {
      await stop()
    }
  })

  it('watch 追加第二行也能收到, 且坏行/半行不打断后续解析', async () => {
    const channel = new CliEventChannel(filePath)
    const received: CliEvent[] = []
    const stop = channel.watch((e) => received.push(e))

    try {
      await fs.writeFile(filePath, '{"ts":"2026-01-01T00:00:00Z","kind":"stop","raw":null}\n', 'utf-8')
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3000, interval: 50 })

      // 追加一条坏行(完整换行终结,但内容损坏——模拟并发写交错截断)
      await fs.appendFile(filePath, 'garbled{{{not-json\n', 'utf-8')

      // 追加一条半行(尚无换行符——模拟正在写入过程中被读到)
      await fs.appendFile(filePath, '{"ts":"2026-01-01T00:00:01Z","kind":"noti', 'utf-8')

      // 给 half-line 一点时间,确认此时不会因半行而报错或提前解析出坏结果
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(received).toHaveLength(1) // 仍只有第一条:坏行被跳过,半行未完成

      // 补全半行
      await fs.appendFile(filePath, 'fication","raw":null}\n', 'utf-8')

      await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 3000, interval: 50 })
      expect(received[1].kind).toBe('notification')
    } finally {
      stop()
    }
  })

  it('stop() 后不再回调', async () => {
    const channel = new CliEventChannel(filePath)
    const received: CliEvent[] = []
    const stop = channel.watch((e) => received.push(e))

    await fs.writeFile(filePath, '{"ts":"2026-01-01T00:00:00Z","kind":"stop","raw":null}\n', 'utf-8')
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3000, interval: 50 })

    await stop()

    await fs.appendFile(filePath, '{"ts":"2026-01-01T00:00:01Z","kind":"notification","raw":null}\n', 'utf-8')
    // 停止后给足够时间(覆盖轮询周期量级),确认没有新回调
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(received).toHaveLength(1)
  })

  it('disposer 等待正在执行的异步 callback，返回后不再进入新 callback', async () => {
    const channel = new CliEventChannel(filePath)
    const received: string[] = []
    let releaseCallback!: () => void
    const callbackReleased = new Promise<void>((resolve) => { releaseCallback = resolve })

    const stop = channel.watch(async (event) => {
      received.push(event.kind)
      await callbackReleased
    })

    await fs.writeFile(filePath, '{"ts":"2026-01-01T00:00:00Z","kind":"stop","raw":null}\n', 'utf-8')
    await vi.waitFor(() => expect(received).toEqual(['stop']), { timeout: 3000, interval: 50 })

    let disposed = false
    const disposePromise = stop().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    releaseCallback()
    await disposePromise

    await fs.appendFile(filePath, '{"ts":"2026-01-01T00:00:01Z","kind":"notification","raw":null}\n', 'utf-8')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(received).toEqual(['stop'])
  })
})
