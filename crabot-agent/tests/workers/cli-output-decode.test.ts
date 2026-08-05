import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { ClaudeCodeAdapter } from '../../src/workers/claude-code/adapter'
import { CodexWorkerAdapter } from '../../src/workers/codex/adapter'
import { BuiltinWorkerAdapter } from '../../src/workers/builtin/adapter'
import type { IncarnationHandle } from '../../src/workers/types'

/**
 * 解 ANSI 是 **CLI 化身特有**的处理:cc/codex 的输出日志是 tmux `pipe-pane` 抓的终端
 * 输出流(TUI 重绘的转义序列增量),builtin 的输出天然是纯文本。这里锁的就是这条边界
 * 落在 adapter 层:两个 CLI adapter 的 readOutput 解码,builtin 的不解。
 *
 * 三个 adapter 的 readOutput 在内存里没有常驻 runtime 时都按约定路径
 * `<dataDir>/<worker_id>/output-<seq>.log` 重建 OutputLog,所以这些用例只需把固件写到
 * 那个路径,不用真的起 tmux / 子进程。
 */
const RAW_FIXTURE = path.join(__dirname, 'fixtures', 'codex-tui-tail.ansi')

describe('CLI worker 输出解码(adapter 层边界)', () => {
  let dataDir: string
  let raw: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-output-decode-'))
    raw = await fs.readFile(RAW_FIXTURE, 'utf-8')
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })

  async function seedOutputLog(workerId: string): Promise<void> {
    await fs.mkdir(path.join(dataDir, workerId), { recursive: true })
    await fs.writeFile(path.join(dataDir, workerId, 'output-1.log'), raw, 'utf-8')
  }

  function handle(workerId: string, impl: IncarnationHandle['impl']): IncarnationHandle {
    return { worker_id: workerId, seq: 1, impl, session_ref: 'unused' }
  }

  it('claude-code adapter 的 readOutput 返回解码后的文本,磁盘原文一字不动', async () => {
    const workerId = 'w-cc-decode'
    await seedOutputLog(workerId)
    const adapter = new ClaudeCodeAdapter({ dataDir })

    const { chunk } = await adapter.readOutput(handle(workerId, 'claude-code'), { offset: 0 })

    expect(chunk).toContain('unexpected status 401 Unauthorized')
    expect(chunk).not.toContain('\x1b')
    expect(chunk.length).toBeLessThan(raw.length / 5)

    expect(await fs.readFile(path.join(dataDir, workerId, 'output-1.log'), 'utf-8')).toBe(raw)
  })

  it('codex adapter 的 readOutput 返回解码后的文本,磁盘原文一字不动', async () => {
    const workerId = 'w-codex-decode'
    await seedOutputLog(workerId)
    const adapter = new CodexWorkerAdapter({ dataDir })

    const { chunk } = await adapter.readOutput(handle(workerId, 'codex'), { offset: 0 })

    expect(chunk).toContain('unexpected status 401 Unauthorized')
    expect(chunk).not.toContain('\x1b')
    expect(chunk.length).toBeLessThan(raw.length / 5)

    expect(await fs.readFile(path.join(dataDir, workerId, 'output-1.log'), 'utf-8')).toBe(raw)
  })

  it('复刻现网事故:172KB 量级的日志、致命错误在尾部,manager 这条路读得到它', async () => {
    // 事故形状:开头是海量启动噪音(那次 manager 只读到 byte 13965 处的"Reconnecting"中途
    // 症状,把它当成了根因),真正的 401 落在远超 byte-cap 的位置,只有尾部才有。
    const workerId = 'w-incident-shape'
    const startupNoise = '\x1b[2J\x1b[H\x1b[38;5;220mReconnecting... 2/5 Connection reset by peer\x1b[0m'
    const bloated = startupNoise.repeat(3000) + raw
    expect(bloated.length).toBeGreaterThan(170_000)

    await fs.mkdir(path.join(dataDir, workerId), { recursive: true })
    await fs.writeFile(path.join(dataDir, workerId, 'output-1.log'), bloated, 'utf-8')

    const adapter = new CodexWorkerAdapter({ dataDir })
    const { chunk, nextCursor } = await adapter.readOutput(handle(workerId, 'codex'), { offset: 0 })

    expect(chunk).toContain('unexpected status 401 Unauthorized')
    expect(chunk).toContain('invalid_api_key')
    expect(nextCursor.offset).toBe(Buffer.byteLength(bloated, 'utf-8'))
  })

  it('builtin adapter 不解码:它的输出本来就是纯文本,不该被这套重放动过', async () => {
    const workerId = 'w-builtin-nodecode'
    await seedOutputLog(workerId)
    const adapter = new BuiltinWorkerAdapter({ dataDir })

    const { chunk } = await adapter.readOutput(handle(workerId, 'builtin'), { offset: 0 })

    expect(chunk).toBe(raw)
  })
})
