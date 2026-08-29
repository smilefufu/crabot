import { describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createOutputTool } from '../../src/engine/tools/output-tool.js'
import type { BgEntityRegistry } from '../../src/engine/bg-entities/registry.js'
import type { ToolCallContext } from '../../src/engine/types.js'

/** 事故复现（spec 2026-08-29 §7.3/§7.7）：worker 卡在 Output(block=true) 的 poll loop 里
 * 时 manager 投递到达——探针让 Output 提前返回，不等满 timeout。 */
function shellRegistry(logFile: string): BgEntityRegistry {
  return {
    get: async () => ({
      entity_id: 'shell_test',
      type: 'shell',
      status: 'running',
      exit_code: null,
      command: 'tail -f runner.log',
      log_file: logFile,
      pid: 1,
      pgid: 1,
      process_started_at: new Date().toISOString(),
      spawned_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      owner_friend_id: '__system_w1',
      worker_id: 'w1',
    }),
    update: async () => {},
  } as unknown as BgEntityRegistry
}

function makeContext(probe?: () => boolean): ToolCallContext {
  return { ...(probe ? { hasPendingExternalInput: probe } : {}) }
}

describe('Output block=true 的外部输入 pending 探针', () => {
  it('探针为 true 时立即返回,不等满 timeout(默认未接线时行为不变)', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'output-probe-'))
    const logFile = join(dir, 'shell.log')
    await fs.writeFile(logFile, '') // 空日志 → 无新输出 → 正常情况下会 block 到超时

    const tool = createOutputTool({
      registry: shellRegistry(logFile),
      cursorMap: new Map(),
      taskId: 'w1',
    })

    // 探针恒 true:第一次 poll 睡醒(2s)前就该返回
    const start = Date.now()
    const result = await tool.call({ entity_id: 'shell_test', block: true, timeout_ms: 60_000 }, makeContext(() => true))
    const elapsed = Date.now() - start

    expect(result.output).toContain('(no new output)')
    expect(elapsed).toBeLessThan(5_000) // 未修复时会等满 60s
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('探针始终 false 时不提前返回,行为与现状一致(等到超时)', { timeout: 15_000 }, async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'output-probe-'))
    const logFile = join(dir, 'shell.log')
    await fs.writeFile(logFile, '')

    const tool = createOutputTool({
      registry: shellRegistry(logFile),
      cursorMap: new Map(),
      taskId: 'w1',
    })

    const start = Date.now()
    await tool.call({ entity_id: 'shell_test', block: true, timeout_ms: 5_000 }, makeContext(() => false))
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(4_500) // 等满 timeout
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('未接线(无探针)时行为与现状一致', { timeout: 15_000 }, async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'output-probe-'))
    const logFile = join(dir, 'shell.log')
    await fs.writeFile(logFile, '')

    const tool = createOutputTool({
      registry: shellRegistry(logFile),
      cursorMap: new Map(),
      taskId: 'w1',
    })

    const start = Date.now()
    await tool.call({ entity_id: 'shell_test', block: true, timeout_ms: 3_000 }, {})
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(2_500)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('事故时序复现:日志先无输出,投递(探针翻转)后 Output 提前让位', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'output-probe-'))
    const logFile = join(dir, 'shell.log')
    await fs.writeFile(logFile, '')

    const tool = createOutputTool({
      registry: shellRegistry(logFile),
      cursorMap: new Map(),
      taskId: 'w1',
    })

    // 模拟「投递在 block 等待中途到达」:fake 时间 300ms 后探针翻转(对应 sendInput → pending 非空)。
    // 定时器必须在 useFakeTimers 之后注册才会进 fake 队列。
    vi.useFakeTimers()
    try {
      let pending = false
      setTimeout(() => { pending = true }, 300)
      const call = tool.call({ entity_id: 'shell_test', block: true, timeout_ms: 60_000 }, makeContext(() => pending))
      await vi.advanceTimersByTimeAsync(3_000) // 推进 fake 时间:300ms 翻转 + 2s poll 睡醒即见探针
      const result = await call
      expect(result.output).toContain('(no new output)') // 让位时日志仍无新内容
    } finally {
      vi.useRealTimers()
    }
    await fs.rm(dir, { recursive: true, force: true })
  })
})
