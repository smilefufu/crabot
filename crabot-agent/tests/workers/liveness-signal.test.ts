import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { ClaudeCodeAdapter } from '../../src/workers/claude-code/adapter'
import { CodexWorkerAdapter } from '../../src/workers/codex/adapter'
import { BuiltinWorkerAdapter } from '../../src/workers/builtin/adapter'
import type { IncarnationHandle, WorkerAdapter } from '../../src/workers/types'

/**
 * 可选契约方法 `lastActivityAt`(protocol-agent-v3 §6.1)在 adapter 层的落点:
 * **cc/codex 各自实现为对自己 output 日志的一次 mtime 探测,builtin 不实现**。
 *
 * 两个 CLI adapter 在内存里没有常驻 runtime 时都按约定路径
 * `<dataDir>/<worker_id>/output-<seq>.log` 重建 OutputLog(与 readOutput 同一条路径解析),
 * 所以这些用例只需把固件写到那个路径,不用真的起 tmux;这同时也锁住了"agent 重启后仍然
 * 判得了活性"这条性质。
 *
 * 两侧对称覆盖:参数化跑两遍,避免只给 cc 写用例、删掉 codex 一侧实现还能全绿。
 */
describe('lastActivityAt(活性信号,adapter 层边界)', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'liveness-signal-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })

  function handle(workerId: string, impl: IncarnationHandle['impl']): IncarnationHandle {
    return { worker_id: workerId, seq: 1, impl, session_ref: 'unused' }
  }

  const cases: Array<[IncarnationHandle['impl'], () => WorkerAdapter]> = [
    ['claude-code', () => new ClaudeCodeAdapter({ dataDir })],
    ['codex', () => new CodexWorkerAdapter({ dataDir })],
  ]

  it.each(cases)('%s:返回 output 日志的 mtime,写入后随之前进', async (impl, make) => {
    const workerId = `w-${impl}-activity`
    const adapter = make()
    const h = handle(workerId, impl)
    const logPath = path.join(dataDir, workerId, 'output-1.log')

    await fs.mkdir(path.join(dataDir, workerId), { recursive: true })
    await fs.writeFile(logPath, 'first frame', 'utf-8')
    // mtime 摆到一个确定的过去时刻:这正是"化身很久没动"的现场形态
    const stalledAt = Date.parse('2026-08-05T00:00:00.000Z')
    await fs.utimes(logPath, new Date(stalledAt), new Date(stalledAt))

    expect(await adapter.lastActivityAt!(h)).toBe(stalledAt)

    // 又吐了一帧(TUI 自旋动画持续写字节)→ 信号前进
    const movedAt = stalledAt + 60_000
    await fs.appendFile(logPath, ' next frame', 'utf-8')
    await fs.utimes(logPath, new Date(movedAt), new Date(movedAt))
    expect(await adapter.lastActivityAt!(h)).toBe(movedAt)
  })

  it.each(cases)('%s:日志文件还不存在 → undefined(判不了,不是"很久没动")', async (impl, make) => {
    const adapter = make()
    expect(await adapter.lastActivityAt!(handle(`w-${impl}-nolog`, impl))).toBeUndefined()
  })

  it('builtin 不实现该方法:它的 output 只在有 assistantText 时才写,没有连续活性信号', () => {
    const adapter: WorkerAdapter = new BuiltinWorkerAdapter({ dataDir })
    // 巡检据此天然跳过它(harness 侧没有、也不该有 `if (impl === 'builtin')` 这类特判)
    expect(adapter.lastActivityAt).toBeUndefined()
  })
})
