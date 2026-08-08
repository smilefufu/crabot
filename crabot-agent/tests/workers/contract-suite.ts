/**
 * 可复用的 WorkerAdapter 契约一致性套件——与实现无关的行为断言，供 builtin（本文件的
 * contract-builtin.test.ts）以及 P2 的 claude-code / codex tmux adapter 复跑同一套。
 *
 * 每个 fixture 提供一个 makeSpec(workerId, script)：script 是一串 ScriptStep，第一个
 * step 由 spawn 触发的初始 burst 消费，此后每次 sendInput 依次消费下一个 step——具体怎么
 * 让底层实现（builtin 用 mock LLMAdapter；P2 用 mock CLI）按这个顺序吐输出，是 fixture 的
 * 职责，契约套件本身不关心。
 *
 * session_ref（IncarnationRef 里喂给 fork/resume 的字段）是逐 impl 不透明的格式（builtin：
 * session 树 node_id；CLI：原生 session id）。P3 Task 7 之前 WorkerAdapter 接口没有从 handle
 * 反查它的方法，fixture 曾各自实现一个 refFor(handle) 读 meta 文件绕过这个缺口；现在
 * IncarnationHandle 自身就带 session_ref（protocol-agent-v3 §6.1，spawn/resume/fork 返回前
 * 由 adapter 填入真值），fixture 不再需要这条旁路，下面的 toRef() 直接从 handle 取值即可。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import type {
  WorkerAdapter,
  IncarnationHandle,
  IncarnationRef,
  SpawnSpec,
  WorkerContractState,
} from '../../src/workers/types.js'

export interface ScriptStep {
  readonly output: string
  readonly then: 'idle' | 'exit_success' | 'exit_failure'
}

export interface ContractFixture {
  readonly adapter: WorkerAdapter
  /** 每次 sendInput 消费下一个 script step；第一个 step 由 spawn 的初始 burst 消费。 */
  readonly makeSpec: (workerId: string, script: ScriptStep[]) => SpawnSpec
  readonly cleanup: () => Promise<void>
}

export type MakeFixture = () => Promise<ContractFixture>

/** IncarnationHandle → IncarnationRef：handle 自身已携带真实 session_ref（protocol-agent-v3
 * §6.1），直接取值即可，不需要 fixture 另外提供反查通路。 */
function toRef(h: IncarnationHandle): IncarnationRef {
  return { worker_id: h.worker_id, seq: h.seq, session_ref: h.session_ref }
}

/**
 * 状态收敛轮询：100ms 间隔、5s 超时——给未来 tmux 实现（拉起真实进程）留够裕量。
 * `targets` 允许传多个可接受的终态（例如"idle 或 exited 皆可"），单个轮询循环里判定，
 * 不用 Promise.race 叠两个独立循环——否则赢家 resolve 后，输家那个循环仍在后台继续跑
 * 到自己的超时才抛错，变成没人 await 的 unhandled rejection。
 */
async function waitForState(
  adapter: WorkerAdapter,
  h: IncarnationHandle,
  targets: WorkerContractState | ReadonlyArray<WorkerContractState>,
): Promise<void> {
  const targetList = Array.isArray(targets) ? targets : [targets as WorkerContractState]
  const intervalMs = 100
  const deadline = Date.now() + 5000
  let last: WorkerContractState | undefined
  while (Date.now() < deadline) {
    last = await adapter.state(h)
    if ((targetList as WorkerContractState[]).includes(last)) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`waitForState timeout: expected one of [${targetList.join(', ')}], last seen '${last}'`)
}

/** 每个 it 单独起一个 worker，靠随机 worker_id 隔离，不依赖 fixture 内部如何划分数据目录。 */
function freshWorkerId(): string {
  return `contract-${randomUUID()}`
}

export function runContractSuite(name: string, makeFixture: MakeFixture): void {
  describe(`WorkerAdapter contract: ${name}`, () => {
    let fx: ContractFixture

    beforeEach(async () => {
      fx = await makeFixture()
    })

    afterEach(async () => {
      await fx.cleanup()
    })

    it(
      '① spawn → burst(idle) → state 收敛 idle，readOutput 含该 step 输出',
      async () => {
        const spec = fx.makeSpec(freshWorkerId(), [{ output: '第一段输出', then: 'idle' }])
        const h = await fx.adapter.spawn(spec)
        // handle.session_ref 由 adapter 在 spawn 返回前即填入真值（protocol-agent-v3
        // §6.1），跨三个实现的通用契约断言：不能是空串。
        expect(h.session_ref).toBeTruthy()
        await waitForState(fx.adapter, h, 'idle')

        const { chunk } = await fx.adapter.readOutput(h, { offset: 0 })
        expect(chunk).toContain('第一段输出')
      },
      15000,
    )

    it(
      '② readOutput 游标增量：同一游标二次读为空，不重复吐旧内容',
      async () => {
        const spec = fx.makeSpec(freshWorkerId(), [{ output: '第一段输出', then: 'idle' }])
        const h = await fx.adapter.spawn(spec)
        await waitForState(fx.adapter, h, 'idle')

        const first = await fx.adapter.readOutput(h, { offset: 0 })
        expect(first.chunk).toContain('第一段输出')

        const second = await fx.adapter.readOutput(h, first.nextCursor)
        expect(second.chunk).not.toContain('第一段输出')
      },
      15000,
    )

    it(
      '③ sendInput(idle) → 消费下一个 step，输出追加而非覆盖',
      async () => {
        const spec = fx.makeSpec(freshWorkerId(), [
          { output: '第一段输出', then: 'idle' },
          { output: '第二段输出', then: 'idle' },
        ])
        const h = await fx.adapter.spawn(spec)
        await waitForState(fx.adapter, h, 'idle')

        const before = await fx.adapter.readOutput(h, { offset: 0 })
        expect(before.chunk).toContain('第一段输出')

        await fx.adapter.sendInput(h, '继续')
        await waitForState(fx.adapter, h, 'idle')

        const after = await fx.adapter.readOutput(h, { offset: 0 })
        expect(after.chunk).toContain('第一段输出')
        expect(after.chunk).toContain('第二段输出')

        const incremental = await fx.adapter.readOutput(h, before.nextCursor)
        expect(incremental.chunk).toContain('第二段输出')
        // CLI TUI may redraw earlier history while editing/submitting; the cursor contract guarantees
        // byte/log progression, not semantic de-duplication of terminal redraws.
      },
      15000,
    )

    it.each(['exit_success', 'exit_failure'] as const)(
      '④ %s step → 收敛 exited',
      async (then) => {
        const spec = fx.makeSpec(freshWorkerId(), [{ output: '收尾输出', then }])
        const h = await fx.adapter.spawn(spec)
        await waitForState(fx.adapter, h, 'exited')
        expect(await fx.adapter.state(h)).toBe('exited')
      },
      15000,
    )

    it(
      '⑤ 对 exited 化身 sendInput 必须拒绝（错误类型不限定）',
      async () => {
        const spec = fx.makeSpec(freshWorkerId(), [{ output: '收尾输出', then: 'exit_success' }])
        const h = await fx.adapter.spawn(spec)
        await waitForState(fx.adapter, h, 'exited')

        let rejected = false
        try {
          await fx.adapter.sendInput(h, '还有件事')
        } catch {
          rejected = true
        }
        expect(rejected).toBe(true)
      },
      15000,
    )

    it(
      '⑥ kill：spawn 后立即 kill → 最终 exited，再次 kill 幂等',
      async () => {
        const spec = fx.makeSpec(freshWorkerId(), [{ output: '不一定会被读到的输出', then: 'idle' }])
        const h = await fx.adapter.spawn(spec)

        await fx.adapter.kill(h)
        await waitForState(fx.adapter, h, 'exited')

        await expect(fx.adapter.kill(h)).resolves.toBeUndefined()
      },
      15000,
    )

    it(
      '⑦a capabilities.fork 声明与实际行为一致',
      async () => {
        const spec = fx.makeSpec(freshWorkerId(), [{ output: '主线输出', then: 'idle' }])
        const h = await fx.adapter.spawn(spec)
        await waitForState(fx.adapter, h, 'idle')
        const ref = toRef(h)
        const caps = fx.adapter.capabilities()

        if (caps.fork) {
          const forkHandle = await fx.adapter.fork(ref, '侧问问题')
          expect(forkHandle.worker_id).toBe(h.worker_id)
          await waitForState(fx.adapter, forkHandle, 'exited')
          const output = await fx.adapter.readOutput(forkHandle, { offset: 0 })
          expect(typeof output.chunk).toBe('string')
        } else {
          await expect(fx.adapter.fork(ref, '侧问问题')).rejects.toBeTruthy()
        }
      },
      15000,
    )

    it(
      '⑦b capabilities.revive 声明与实际行为一致',
      async () => {
        const spec = fx.makeSpec(freshWorkerId(), [{ output: '主线输出', then: 'exit_success' }])
        const h = await fx.adapter.spawn(spec)
        await waitForState(fx.adapter, h, 'exited')
        const ref = toRef(h)
        const caps = fx.adapter.capabilities()

        if (caps.revive) {
          const revivedHandle = await fx.adapter.resume(ref, '唤醒输入')
          expect(revivedHandle.worker_id).toBe(h.worker_id)
          // 不同实现续跑后的落定状态语义可能不同（idle / exited 都合法），只要求最终不再是
          // 一直卡着——两者之一即可，同时验证输出通路可用。
          await waitForState(fx.adapter, revivedHandle, ['idle', 'exited'])
          const output = await fx.adapter.readOutput(revivedHandle, { offset: 0 })
          expect(typeof output.chunk).toBe('string')
        } else {
          await expect(fx.adapter.resume(ref, '唤醒输入')).rejects.toBeTruthy()
        }
      },
      15000,
    )

    it('⑧ detect() 返回结构合法', async () => {
      const result = await fx.adapter.detect()
      expect(typeof result.installed).toBe('boolean')
      expect(typeof result.activated).toBe('boolean')
      if (result.detail !== undefined) {
        expect(typeof result.detail).toBe('string')
      }
    })
  })
}
