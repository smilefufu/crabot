/**
 * `src/core/stdio-guard.ts` —— 2026-08-05 事故的回归测试。
 *
 * 事故：LLM 端点抖动 → 重试逻辑刷屏打日志 → MM 被 SIGTERM 后 stderr 管道读端关闭 →
 * `console.error` 的 EPIPE 变成 uncaughtException → agent 被自己的兜底处理器 exit(1)。
 *
 * 两层验证，缺一不可：
 *
 * | 层 | 手法 | 证明什么 |
 * |---|---|---|
 * | ① 真复现 | spawn 子进程 → 关掉管道读端 → 子进程继续 `console.error` | EPIPE 真的会打死进程，且守卫真的拦得住 |
 * | ② 事件语义 | 本进程装守卫后手动 emit EPIPE | 生产函数装的是常驻 'error' 监听器（变异检测口） |
 *
 * ① 之所以要子进程：EPIPE 只有在"真有一根读端已关闭的管道"时才产生，vitest 自己的进程里
 * 造不出来（它的 stdout/stderr 归 vitest 管，弄坏了整个 runner 就没输出了）。子进程跑
 * `node --experimental-strip-types`（Node 22.6+）直接 import 生产 .ts —— Node < 22.6 上该
 * 用例会 skip，此时只剩 ② 兜着（②对"删掉监听器"这一变异同样敏感）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { installStdioErrorGuard } from '../../src/core/stdio-guard.js'

const CHILD = fileURLToPath(new URL('./fixtures/stdio-epipe-child.ts', import.meta.url))

/** Node 22.6+ 才有 type stripping；老版本上没法在子进程里直接跑生产 .ts。 */
const CAN_STRIP_TYPES = process.allowedNodeEnvironmentFlags.has('--experimental-strip-types')

/**
 * 起一个子进程，40ms 后掐掉它 stdout/stderr 的读端，返回它的退出码。
 * 退出码 42 = 子进程内的 uncaughtException 处理器开火（即事故形态）；0 = 活到自己跑完。
 */
function runChildWithBrokenPipe(guard: boolean): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', CHILD], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GUARD: guard ? '1' : '0' },
    })
    child.stdout.on('data', () => {})
    child.stderr.on('data', () => {})
    // 读端一关，子进程后续的写就是 EPIPE
    setTimeout(() => {
      child.stdout.destroy()
      child.stderr.destroy()
    }, 40)
    child.on('error', reject)
    child.on('exit', (code) => resolve(code))
  })
}

describe('installStdioErrorGuard —— 日志写失败不得打死进程', () => {
  afterEach(() => {
    process.stdout.removeAllListeners('error')
    process.stderr.removeAllListeners('error')
  })

  it.skipIf(!CAN_STRIP_TYPES)(
    '真复现：管道读端关闭后继续 console.error —— 不装守卫必崩，装了守卫活到跑完',
    async () => {
      // 不装守卫 = 事故当天的现场。这一条同时也是"复现有效"的自证：它若不再是 42，
      // 说明这个复现装置已经测不到东西了，下面那条"装了守卫是 0"也就不再有意义。
      expect(await runChildWithBrokenPipe(false)).toBe(42)

      expect(await runChildWithBrokenPipe(true)).toBe(0)
    },
    20_000,
  )

  it('装上守卫后，stdout/stderr 的 EPIPE 事件不再变成 uncaughtException', () => {
    installStdioErrorGuard()

    // 不装守卫时零监听器的 'error' 会被 EventEmitter 直接抛出（= 生产里的 uncaughtException）。
    for (const stream of [process.stdout, process.stderr]) {
      const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' })
      expect(() => stream.emit('error', epipe)).not.toThrow()
    }
  })

  it('监听器是常驻的，不是 once —— 事故正是从第二条日志开始崩的', () => {
    installStdioErrorGuard()

    const err = (): Error => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    expect(() => process.stderr.emit('error', err())).not.toThrow()
    expect(() => process.stderr.emit('error', err())).not.toThrow()
    expect(() => process.stderr.emit('error', err())).not.toThrow()
  })

  it('EIO / ERR_STREAM_DESTROYED 一并吞掉（只筛 EPIPE 等于把同一场崩溃搬到别的码上）', () => {
    installStdioErrorGuard()

    for (const code of ['EIO', 'ERR_STREAM_DESTROYED']) {
      const err = Object.assign(new Error(`write ${code}`), { code })
      expect(() => process.stderr.emit('error', err)).not.toThrow()
    }
  })
})
