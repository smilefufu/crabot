/**
 * WorkerHarness — 真实 adapter 集成冒烟(P3 Task 10)。
 *
 * Task 7-9 的 harness 测试全部用 FakeAdapter 桩证明编排逻辑本身正确,但从未验证过
 * harness 与真实 adapter 之间的接线契约(onStateChange 绑定顺序、handle 字段、
 * capabilities() 判断)是否真的对得上——桩可以被写成"凑巧满足断言"的样子,不代表真实
 * adapter 也这样用。本文件补上这一层:
 *
 * 1. 真实 BuiltinWorkerAdapter(mock LLM,不碰真实网络)跑一遍 spawn → getWorkerTerminal →
 *    sendToWorker 续跑 → finish_task → 台账终态 → reconcileOnStartup 幂等的全链路。
 * 2. 真实 ClaudeCodeAdapter + mock CLI(tests/workers/fixtures/mock-cli.mjs)+ 真实 tmux
 *    (无 tmux 环境 skip)跑 spawn → sendToWorker → killWorker,断言台账/事件正确。
 * 3. 真实 tmux 场景复现并验证 Task 9 评审指出的缺口修复:cc adapter 的 state() 在无常驻
 *    runtime(agent 重启后新建的 adapter 实例)时不再照抄 meta 旧值,而是先做一次 tmux
 *    isAlive 探测——叠加 harness.reconcileOnStartup,证明"重启后仍存活的 worker 归
 *    revived、被外部杀掉 tmux 会话的 worker 归 failed"。
 *
 * 三个 adapter 都按 harness.ts 文件头"onStateChange 接线契约"的真实顺序接线(先建空壳
 * Map 传给 harness,harness 构造完成后再构造 adapter 把 harness.handleStateChange 传入
 * 构造函数,最后把 adapter 塞回同一个 Map 引用),不是像 Task 7-9 FakeAdapter 那样手动
 * 调用 onStateChange 触发回调。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import * as path from 'node:path'

import { WorkerHarness, type HarnessDeps } from '../../../src/workers/harness/harness'
import { LedgerStore } from '../../../src/workers/harness/ledger-store'
import { WorkspaceManager } from '../../../src/workers/harness/workspace-manager'
import { } from '../../../src/workers/harness/ledger-types'
import type { HarnessEvent } from '../../../src/workers/harness/worker-events'
import { BuiltinWorkerAdapter } from '../../../src/workers/builtin/adapter.js'
import { ClaudeCodeAdapter, eventsFilePath as ccEventsFilePath } from '../../../src/workers/claude-code/adapter.js'
import { CliEventChannel } from '../../../src/workers/cli-events.js'
import type { WorkerImplId, WorkerAdapter } from '../../../src/workers/types'
import type { LLMAdapter } from '../../../src/engine/llm-adapter-types.js'
import { chunksFromContent } from '../../engine/helpers/mock-stream.js'

async function waitUntil(cond: () => Promise<boolean> | boolean, timeoutMs = 8000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('waitUntil timed out')
}

// ---- Part 1: 真实 builtin adapter(mock LLM)----

function makeLLM(
  responses: Array<{
    text?: string
    toolCalls?: Array<{ name: string; id: string; input: Record<string, unknown> }>
    stopReason: 'end_turn' | 'tool_use'
  }>,
): LLMAdapter {
  let i = 0
  return {
    stream: vi.fn(async function* () {
      const r = responses[i++] ?? responses[responses.length - 1]
      const content: unknown[] = []
      if (r.text) content.push({ type: 'text', text: r.text })
      for (const tc of r.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      }
      yield* chunksFromContent(content, r.stopReason, { inputTokens: 100, outputTokens: 50 })
    }),
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

describe('WorkerHarness — 真实 builtin adapter 集成冒烟(mock LLM)', () => {
  let dataDir: string
  let nowValue: number
  const events: HarnessEvent[] = []

  function now(): string {
    nowValue += 1000
    return new Date(nowValue).toISOString()
  }

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'harness-integ-builtin-'))
    nowValue = Date.parse('2026-01-01T00:00:00.000Z')
    events.length = 0
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it(
    'spawn → getWorkerTerminal → sendToWorker 续跑 → finish_task → 台账终态正确,reconcileOnStartup 幂等不误判已终态',
    async () => {
      const ledgersDir = join(dataDir, 'ledgers')
      const workspacesRoot = join(dataDir, 'workspaces')
      const workersDir = join(dataDir, 'workers')
      const builtinDataDir = join(dataDir, 'builtin-adapter')
      await fs.mkdir(workspacesRoot, { recursive: true })

      const ledger = new LedgerStore(ledgersDir)
      const workspaces = new WorkspaceManager(workspacesRoot)
      const adaptersMap = new Map<WorkerImplId, WorkerAdapter>()
      const deps: HarnessDeps = {
        adapters: adaptersMap,
        defaultImpl: 'builtin',
        ledger,
        workspaces,
        workersDir,
        now,
        onEvent: (e) => events.push(e),
      }
      const harness = new WorkerHarness(deps)
      // onStateChange 接线契约(harness.ts 文件头):harness 先构造好、把 handleStateChange
      // 传给真实 adapter 的构造函数,再把 adapter 塞回同一个底层 Map——与 P4 的真实接线顺序
      // 完全一致,不是像 Task 7-9 的 FakeAdapter 那样手动模拟回调触发。
      const builtinAdapter = new BuiltinWorkerAdapter({ dataDir: builtinDataDir, onStateChange: harness.handleStateChange })
      adaptersMap.set('builtin', builtinAdapter)

      const llm = makeLLM([
        { text: '先看看情况,遇事不决,问一句:A 还是 B?', stopReason: 'end_turn' },
        { toolCalls: [{ name: 'finish_task', id: 'call_1', input: { outcome: 'completed', summary: '搞定了' } }], stopReason: 'tool_use' },
      ])

      const managerKey = `test::friend-builtin-integ` as ManagerKey
      const worker = await harness.spawnWorker({
        managerKey,
        title: '集成冒烟任务',
        prompt: '把活干完',
        origin: {
      trigger_type: 'message' },
        report_to: { channel_id: 'wechat', session_id: 'sess-1' },
        impl: 'builtin',
        builtin: { adapter: llm, model: 'test', systemPrompt: '', tools: [] },
      })

      expect(worker.task.status).toBe('running')
      expect(worker.incarnations[0].session_ref).toBeTruthy()

      // burst 是 fire-and-forget:等真实的 onStateChange → harness.handleStateChange 回调把
      // 台账推进到 waiting_input(builtin 的 idle 映射,harness 保守默认 idle→waiting_input),
      // 不是靠猜时序或手动触发回调。
      await waitUntil(async () => {
        const [w] = await harness.listWorkers(managerKey)
        return w.task.status === 'halted'
      })

      // 经 harness.getWorkerTerminal(不是直接戳 adapter)拿到 builtin 真实写盘的纯文本。
      const terminal = await harness.getWorkerTerminal(worker.worker_id)
      expect(terminal).toMatchObject({ kind: 'headless_text', text: expect.stringContaining('A 还是 B') })

      // sendToWorker 续跑:走 harness 的正常投递路径(per-worker 锁 + inbox.flush),命中
      // 真实 adapter.sendInput,不是断言 FakeAdapter 桩记录的 sendInputCalls。
      await harness.sendToWorker(worker.worker_id, '选 A 吧,继续')

      await waitUntil(async () => {
        const [w] = await harness.listWorkers(managerKey)
        return w.task.status === 'halted'
      })

      const [finalWorker] = await harness.listWorkers(managerKey)
      expect(finalWorker.task.status).toBe('halted')
      // 注:被动状态回调路径现在会把 adapter 的 ended_reason 一路透传进
      // incarnation.ended_reason 与 task.status,但**不**回填 task.outcome——
      // applyStatusTransition 的 opts.outcome 至今没有任何生产调用点传值,该字段恒
      // undefined。终态判定完全靠 task.status + incarnation.ended_reason;激活 task.outcome
      // 是独立议题(它是宽松的 string,装什么要单独定死),不是本次集成测试要覆盖的缺口。
      expect(finalWorker.incarnations).toHaveLength(1)
      expect(finalWorker.incarnations[0].state).toBe('exited')
      expect(finalWorker.incarnations[0].ended_reason).toBe('completed')

      expect(events.filter((e) => e.kind === 'lifecycle_changed'
        && (e.detail as { change?: string } | undefined)?.change === 'spawned')).toHaveLength(1)
      expect(events.filter((e) => e.kind === 'input_sent')).toHaveLength(1)
      // 至少两次真实状态回调(idle 一次、exited 一次)经 handleStateChange 落盘并外发。
      expect(events.filter((e) => e.kind === 'state_changed').length).toBeGreaterThanOrEqual(2)

      // reconcileOnStartup 幂等:worker 已是终态,巡检不该把它错误判成 revived/failed,
      // 也不该再调用 adapter.state()(harness.ts reconcileOnStartup 的设计:已终态 worker
      // 直接归 unchanged,不进 Promise.allSettled 批次)——台账不应被巡检动过。
      const beforeReconcile = await harness.listWorkers(managerKey)
      const report = await harness.reconcileOnStartup()
      expect(report.unchanged).toContain(worker.worker_id)
      expect(report.revived).not.toContain(worker.worker_id)
      expect(report.failed).not.toContain(worker.worker_id)
      const afterReconcile = await harness.listWorkers(managerKey)
      expect(afterReconcile).toEqual(beforeReconcile)

      // 再调用一次,证明幂等不是"只对一次调用生效"的巧合。
      const report2 = await harness.reconcileOnStartup()
      expect(report2.unchanged).toContain(worker.worker_id)
    },
    15000,
  )
})

// ---- Part 2/3: 真实 claude-code adapter + mock CLI + 真实 tmux ----

function detectTmux(): boolean {
  const socket = `crabot-vitest-${process.pid}`
  try {
    execFileSync('which', ['tmux'], { stdio: 'ignore' })
    execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'probe', 'exit 0'], { stdio: 'ignore' })
    execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' })
    return true
  } catch {
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }) } catch {}
    return false
  }
}
const tmuxAvailable = detectTmux()

const MOCK_CLI = path.resolve(__dirname, '../fixtures/mock-cli.mjs')

interface MockStep {
  output?: string
  emitStop?: boolean
  exit?: boolean
  exitCode?: number
}

// POSIX shell 单引号转义,与 tmux/driver.ts 的私有 shQuote 同款用法(独立复制一份,与
// tests/workers/claude-code-adapter.test.ts 的同名 helper 同一先例)。
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** 拼一条 `env MOCK_CLI_SCRIPT=... MOCK_CLI_STOP_HOOK_CMD=... node mock-cli.mjs` 命令行,
 * 充当测试用的 claudeBin——mock CLI 不解析 settings.json,直接从 env 拿脚本和 stop hook 命令。 */
function claudeBinFor(script: MockStep[], stopHookCmd: string): string {
  return `env MOCK_CLI_SCRIPT=${shQuote(JSON.stringify(script))} MOCK_CLI_STOP_HOOK_CMD=${shQuote(stopHookCmd)} node ${shQuote(MOCK_CLI)}`
}

async function killTmuxSessionsQuietly(names: readonly string[]): Promise<void> {
  for (const name of names) {
    try {
      execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' })
    } catch {
      // 会话已不存在(如已被 adapter.kill 正常收尾),忽略。
    }
  }
}

describe.skipIf(!tmuxAvailable)('WorkerHarness — 真实 claude-code adapter 集成冒烟(mock CLI + 真实 tmux)', () => {
  let dataDir: string
  let workspaceRoot: string
  let nowValue: number
  const events: HarnessEvent[] = []
  const sessionsToCleanup: string[] = []

  function now(): string {
    nowValue += 1000
    return new Date(nowValue).toISOString()
  }

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'harness-integ-cc-data-'))
    workspaceRoot = await fs.mkdtemp(join(tmpdir(), 'harness-integ-cc-ws-'))
    nowValue = Date.parse('2026-01-01T00:00:00.000Z')
    events.length = 0
    sessionsToCleanup.length = 0
  })

  afterEach(async () => {
    await killTmuxSessionsQuietly(sessionsToCleanup)
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  it(
    'spawn → sendToWorker → killWorker,台账/事件正确(harness 与真实 cc adapter 的接线,不只是对 FakeAdapter 桩正确)',
    async () => {
      const ledgersDir = join(dataDir, 'ledgers')
      const workspacesRoot = join(dataDir, 'workspaces')
      const workersDir = join(dataDir, 'workers')
      const ccDataDir = join(dataDir, 'cc-adapter')
      await fs.mkdir(workspacesRoot, { recursive: true })

      // workspace 显式指定为预先建好的目录(而不是让 harness 用随机 worker_id 兜底生成),
      // 这样才能在构造 adapter(进而拼出 claudeBin)之前就算出这个 workspace 对应的
      // events-cli.jsonl 路径,喂给 mock CLI 的 MOCK_CLI_STOP_HOOK_CMD——真实场景里 cc
      // adapter 的 provision() 会把等价的 hook 命令写进 .claude/settings.json,这里只是
      // 用 mock CLI 直接执行同一段命令,省去解析 settings.json。
      const channel = new CliEventChannel(ccEventsFilePath({ root: workspaceRoot }))
      const stopHookCmd = channel.hookCommand('stop')
      const claudeBin = claudeBinFor(
        [
          { output: '第一段输出', emitStop: true },
          { output: '第二段输出', emitStop: true },
        ],
        stopHookCmd,
      )

      const ledger = new LedgerStore(ledgersDir)
      const workspaces = new WorkspaceManager(workspacesRoot)
      const adaptersMap = new Map<WorkerImplId, WorkerAdapter>()
      const deps: HarnessDeps = {
        adapters: adaptersMap,
        defaultImpl: 'claude-code',
        ledger,
        workspaces,
        workersDir,
        now,
        onEvent: (e) => events.push(e),
      }
      const harness = new WorkerHarness(deps)
      const ccAdapter = new ClaudeCodeAdapter({ dataDir: ccDataDir, claudeConfigPath: join(dataDir, 'fake-claude.json'), claudeBin, onStateChange: harness.handleStateChange })
      adaptersMap.set('claude-code', ccAdapter)

      const managerKey = `test::friend-cc-integ` as ManagerKey
      const worker = await harness.spawnWorker({
        managerKey,
        title: '真实 cc 冒烟任务',
        prompt: '你好',
        origin: {
      trigger_type: 'message' },
        report_to: { channel_id: 'wechat', session_id: 'sess-1' },
        impl: 'claude-code',
        workspace: workspaceRoot,
      })
      sessionsToCleanup.push(`crabot-w-${worker.worker_id}-1`)

      await waitUntil(async () => {
        const [current] = await harness.listWorkers(managerKey)
        return current.task.status === 'waiting_input'
      })
      const [settledWorker] = await harness.listWorkers(managerKey)
      expect(settledWorker.task.status).toBe('halted')
      // cc adapter 的真实 session uuid(spawn 返回前即由 adapter 填入,不是台账初始化时的
      // 占位空串),证明 harness 原子补写了 adapter.spawn 返回的真实 handle.session_ref。
      expect(settledWorker.incarnations[0].session_ref).toBeTruthy()
      expect(settledWorker.incarnations[0].session_ref).toMatch(/^[0-9a-fA-F-]{36}$/)

      // 经 harness.getWorkerTerminal 轮询到 mock CLI 已渲染的第一段终端画面。
      await waitUntil(async () => {
        const terminal = await harness.getWorkerTerminal(worker.worker_id)
        return terminal.kind === 'live_terminal' && terminal.text.includes('第一段输出')
      })

      // 直接读事件文件确认 Stop hook 真的执行过(证明 CliEventChannel.hookCommand 的产物
      // 被 mock CLI 真实 exec 了一遍,不是 harness/adapter 自己编出来的假信号)。
      await waitUntil(async () => {
        const raw = await fs.readFile(ccEventsFilePath({ root: workspaceRoot }), 'utf-8').catch(() => '')
        return raw.includes('"kind":"stop"')
      })

      // sendToWorker 续跑:走 harness 正常投递路径,命中真实 adapter.sendInput → tmux
      // sendText,不是断言桩记录的调用参数。
      await harness.sendToWorker(worker.worker_id, '继续')

      await waitUntil(async () => {
        const terminal = await harness.getWorkerTerminal(worker.worker_id)
        return terminal.kind === 'live_terminal' && terminal.text.includes('第二段输出')
      })

      // 普通投递先由 harness 落 running；随后 Stop callback 单独结算 waiting_text。
      await waitUntil(() => events.filter((e) => e.kind === 'state_changed').length >= 1)

      await harness.killWorker(worker.worker_id, '冒烟测试收尾')

      const [finalWorker] = await harness.listWorkers(managerKey)
      expect(finalWorker.task.status).toBe('cancelled')
      expect(finalWorker.incarnations).toHaveLength(1)
      expect(finalWorker.incarnations[0].state).toBe('exited')
      expect(finalWorker.incarnations[0].ended_reason).toBe('killed')

      expect(events.filter((e) => e.kind === 'lifecycle_changed'
        && (e.detail as { change?: string } | undefined)?.change === 'spawned')).toHaveLength(1)
      expect(events.filter((e) => e.kind === 'input_sent')).toHaveLength(1)
      // 停止操作结算回执(killed kind 已随事件面收敛删除,停止事实由 operation_settled 承载)
      expect(events.filter((e) => e.kind === 'operation_settled')).toHaveLength(1)
    },
    20000,
  )
})

describe.skipIf(!tmuxAvailable)(
  'WorkerHarness.reconcileOnStartup — 真实 tmux 存活探测(P3 Task 10 修复:cc 的 state() 无 runtime 时不再照抄 meta 旧值)',
  () => {
    let dataDir: string
    let workspaceRoot: string | undefined
    let nowValue: number
    const sessionsToCleanup: string[] = []

    function now(): string {
      nowValue += 1000
      return new Date(nowValue).toISOString()
    }

    beforeEach(async () => {
      dataDir = await fs.mkdtemp(join(tmpdir(), 'harness-integ-cc-restart-'))
      workspaceRoot = undefined
      nowValue = Date.parse('2026-01-01T00:00:00.000Z')
      sessionsToCleanup.length = 0
    })

    afterEach(async () => {
      await killTmuxSessionsQuietly(sessionsToCleanup)
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
      if (workspaceRoot) {
        await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
      }
    })

    it(
      '"重启":新 harness + 新 adapter 实例(内存 runtimes 为空)指向同一份台账/dataDir——仍存活的 worker 归 revived,' +
        '被外部杀掉 tmux 会话(bypass adapter.kill,meta 仍停留在 running)的 worker 归 failed,不是照抄 meta 旧值',
      async () => {
        const ledgersDir = join(dataDir, 'ledgers')
        const workspacesRoot = join(dataDir, 'workspaces')
        const workersDir = join(dataDir, 'workers')
        const ccDataDir = join(dataDir, 'cc-adapter')
        await fs.mkdir(workspacesRoot, { recursive: true })

        // 这组测试只关心 isAlive 探活本身,不依赖 Stop hook/idle 转换——脚本不 emitStop,
        // 进程跑完这一步后原地等下一条 stdin,tmux 会话因此持续存活直到被显式杀掉。
        const claudeBin = claudeBinFor([{ output: '跑着' }], ':')

        const ledger = new LedgerStore(ledgersDir)
        const workspaces = new WorkspaceManager(workspacesRoot)
        const managerKey = `test::friend-cc-restart` as ManagerKey

        // "重启前":harness1 + adapterA spawn 两个 worker。
        const adaptersMap1 = new Map<WorkerImplId, WorkerAdapter>()
        const harness1 = new WorkerHarness({
          adapters: adaptersMap1,
          defaultImpl: 'claude-code',
          ledger,
          workspaces,
          workersDir,
          now,
        })
        const adapterA = new ClaudeCodeAdapter({ dataDir: ccDataDir, claudeConfigPath: join(dataDir, 'fake-claude.json'), claudeBin, onStateChange: harness1.handleStateChange })
        adaptersMap1.set('claude-code', adapterA)

        const aliveWorker = await harness1.spawnWorker({
          managerKey,
          title: '存活 worker',
          prompt: '你好',
          origin: {
      trigger_type: 'message' },
          report_to: { channel_id: 'wechat', session_id: 'sess-1' },
          impl: 'claude-code',
        })
        sessionsToCleanup.push(`crabot-w-${aliveWorker.worker_id}-1`)

        const deadWorker = await harness1.spawnWorker({
          managerKey,
          title: '将被外部杀掉的 worker',
          prompt: '你好',
          origin: {
      trigger_type: 'message' },
          report_to: { channel_id: 'wechat', session_id: 'sess-1' },
          impl: 'claude-code',
        })

        // 绕开 adapter.kill,直接杀死 tmux 会话——模拟"agent 进程重启前,这个 worker 的
        // tmux 会话已经先一步真死(崩溃/被系统 OOM kill 等),但没有任何机制把这件事记进
        // 台账/meta(P3 没有主动巡扫机制)",复现 Task 9 评审指出的"真死判活"场景。
        execFileSync('tmux', ['kill-session', '-t', `crabot-w-${deadWorker.worker_id}-1`], { stdio: 'ignore' })

        // 台账此刻仍然认为两个 worker 都在 running——没人告诉它 deadWorker 已经死了。
        const beforeRestart = await harness1.listWorkers(managerKey)
        expect(beforeRestart.every((w) => w.task.status === 'running')).toBe(true)

        // "重启":全新 harness + adapter 实例,指向同一份台账(同一个 LedgerStore 实例即
        // 代表同一份磁盘台账)和同一个 cc adapter 私有 dataDir,但内存 runtimes 为空——
        // 复现进程重启后新建 adapter 实例、丢失所有内存态的真实状况。
        const adaptersMap2 = new Map<WorkerImplId, WorkerAdapter>()
        const harness2 = new WorkerHarness({
          adapters: adaptersMap2,
          defaultImpl: 'claude-code',
          ledger,
          workspaces,
          workersDir,
          now,
        })
        const adapterB = new ClaudeCodeAdapter({ dataDir: ccDataDir, claudeConfigPath: join(dataDir, 'fake-claude.json'), claudeBin, onStateChange: harness2.handleStateChange })
        adaptersMap2.set('claude-code', adapterB)

        // 修复前:adapterB.state() 无 runtime 时直接读 meta,两个 worker 的 meta 都还停留
        // 在 spawn 时写的 'running'——deadWorker 会被误判成 revived(假阳性)。
        // 修复后:isAlive() 先探活,deadWorker 的 tmux 会话已经不在了,一律判 exited。
        const report = await harness2.reconcileOnStartup()

        expect(report.revived).toContain(aliveWorker.worker_id)
        expect(report.failed).toContain(deadWorker.worker_id)

        const afterAll = await harness2.listWorkers(managerKey)
        const afterAlive = afterAll.find((w) => w.worker_id === aliveWorker.worker_id)!
        expect(afterAlive.task.status).toBe('running')

        const afterDead = afterAll.find((w) => w.worker_id === deadWorker.worker_id)!
        expect(afterDead.task.status).toBe('failed')
        expect(afterDead.incarnations[0].state).toBe('exited')
        expect(afterDead.incarnations[0].ended_reason).toBe('crashed')
      },
      20000,
    )

    it(
      'adapter.state() 本身:isAlive 存活时回落读 meta,tmux 会话被外部杀掉后新实例判 exited(不是照抄 meta 旧值)',
      async () => {
        const ccDataDir = join(dataDir, 'cc-adapter-direct')
        workspaceRoot = await fs.mkdtemp(join(tmpdir(), 'harness-integ-cc-restart-ws-'))

        const claudeBin = claudeBinFor([{ output: '先答一句' }], ':')
        // claudeConfigPath:provision 会往这个"全局 ~/.claude.json"写 workspace 信任记录,
        // 测试注入临时路径,不许碰开发机上的真实文件。
        const adapterA = new ClaudeCodeAdapter({
          dataDir: ccDataDir,
          claudeBin,
          claudeConfigPath: join(dataDir, 'fake-claude.json'),
        })
        await adapterA.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })

        const workerId = `cctest-restart-${randomUUID().slice(0, 8)}`
        sessionsToCleanup.push(`crabot-w-${workerId}-1`)
        const h = await adapterA.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })

        // 等 mock CLI 真的处理完首条输入、写完输出,确认会话已经稳定跑起来。
        await waitUntil(async () => {
          const terminal = await adapterA.readTerminal(h)
          return terminal.kind === 'live_terminal' && terminal.text.includes('先答一句')
        })

        // 模拟"重启":全新 adapter 实例,同一 dataDir,内存 runtimes 为空,从未见过这个化身。
        const adapterB = new ClaudeCodeAdapter({ dataDir: ccDataDir, claudeConfigPath: join(dataDir, 'fake-claude.json'), claudeBin: 'unused-not-invoked-by-state' })

        // tmux 会话仍存活 → 回落读 meta(running,spawn 时写的值)——精度有限但至少不是
        // 编造的 exited。
        expect(await adapterB.state(h)).toBe('running')

        // 绕开 adapter.kill,直接杀死 tmux 会话——meta 文件不会被这次外部 kill 更新,
        // 仍然停留在 'running'。
        execFileSync('tmux', ['kill-session', '-t', `crabot-w-${workerId}-1`], { stdio: 'ignore' })

        // 修复前:adapterB.state() 无 runtime 时直接读 meta,拿到过期的 'running'(假阳性)。
        // 修复后:isAlive() 探测发现会话已死,一律判 exited,不管 meta 写了什么。
        await waitUntil(async () => (await adapterB.state(h)) === 'exited')
      },
      15000,
    )

    it(
      'PoC③(四轮 review):"重启"后 harness2 通过 sendToWorker/killWorker 真正操作仍存活的化身,' +
        '不再抛通用 Error(修复前:adapter.sendInput/kill 对无常驻 runtime 的化身抛通用 Error,' +
        'sendToWorker 会 reject、killWorker 整段失败,task 卡在 running 无法终止)',
      async () => {
        const ledgersDir = join(dataDir, 'ledgers')
        const workspacesRoot = join(dataDir, 'workspaces')
        const workersDir = join(dataDir, 'workers')
        const ccDataDir = join(dataDir, 'cc-adapter')
        await fs.mkdir(workspacesRoot, { recursive: true })

        // 两步都不退出、不 emitStop——会话持续存活到显式 kill,给"重连一个仍存活的会话"
        // 提供稳定的时间窗口。
        const claudeBin = claudeBinFor([{ output: '第一段输出' }, { output: '第二段输出' }], ':')

        const ledger = new LedgerStore(ledgersDir)
        const workspaces = new WorkspaceManager(workspacesRoot)
        const managerKey = `test::friend-cc-poc3` as ManagerKey

        const adaptersMap1 = new Map<WorkerImplId, WorkerAdapter>()
        const harness1 = new WorkerHarness({ adapters: adaptersMap1, defaultImpl: 'claude-code', ledger, workspaces, workersDir, now })
        const adapterA = new ClaudeCodeAdapter({ dataDir: ccDataDir, claudeConfigPath: join(dataDir, 'fake-claude.json'), claudeBin, onStateChange: harness1.handleStateChange })
        adaptersMap1.set('claude-code', adapterA)

        const worker = await harness1.spawnWorker({
          managerKey,
          title: 'PoC③ worker',
          prompt: '你好',
          origin: {
      trigger_type: 'message' },
          report_to: { channel_id: 'wechat', session_id: 'sess-1' },
          impl: 'claude-code',
        })
        sessionsToCleanup.push(`crabot-w-${worker.worker_id}-1`)

        await waitUntil(async () => {
          const terminal = await harness1.getWorkerTerminal(worker.worker_id)
          return terminal.kind === 'live_terminal' && terminal.text.includes('第一段输出')
        })

        // "重启":全新 harness + adapter 实例,指向同一份台账/dataDir,内存 runtimes 为空。
        const adaptersMap2 = new Map<WorkerImplId, WorkerAdapter>()
        const harness2 = new WorkerHarness({ adapters: adaptersMap2, defaultImpl: 'claude-code', ledger, workspaces, workersDir, now })
        const adapterB = new ClaudeCodeAdapter({ dataDir: ccDataDir, claudeConfigPath: join(dataDir, 'fake-claude.json'), claudeBin, onStateChange: harness2.handleStateChange })
        adaptersMap2.set('claude-code', adapterB)

        const report = await harness2.reconcileOnStartup()
        expect(report.revived).toContain(worker.worker_id)

        // 会话仍然存活,压根不该走接续,只是简单投递——修复前这里会因为 adapterB.sendInput
        // 抛通用 Error 而 reject(不是像 WorkerExitedError 那样被接住转接续,是直接穿透)。
        await expect(harness2.sendToWorker(worker.worker_id, '继续')).resolves.toBeUndefined()

        await waitUntil(async () => {
          const terminal = await harness2.getWorkerTerminal(worker.worker_id)
          return terminal.kind === 'live_terminal' && terminal.text.includes('第二段输出')
        })

        // 修复前:adapterB.kill 对无常驻 runtime 的化身直接抛通用 Error,killWorker 没有
        // try/catch,整段失败——task 卡在 running,用户无法终止。
        await harness2.killWorker(worker.worker_id, 'PoC③ 收尾')

        const [finalWorker] = await harness2.listWorkers(managerKey)
        expect(finalWorker.task.status).toBe('cancelled')
        expect(finalWorker.incarnations[0].state).toBe('exited')
        expect(finalWorker.incarnations[0].ended_reason).toBe('killed')
      },
      20000,
    )

    it(
      'PoC④(四轮 review):sendToWorker 撞上已经死掉的 tmux 会话(未先调 reconcileOnStartup)时经透明接续正确续办,' +
        '不永久卡在 running(修复前:WorkerExitedError 被通用 Error 掩盖,continueTerminalWorker 走不到,' +
        '消息永久卡在 inbox 队首)',
      async () => {
        const ledgersDir = join(dataDir, 'ledgers')
        const workspacesRoot = join(dataDir, 'workspaces')
        const workersDir = join(dataDir, 'workers')
        const ccDataDir = join(dataDir, 'cc-adapter')
        await fs.mkdir(workspacesRoot, { recursive: true })

        const claudeBin = claudeBinFor([{ output: '第一段输出' }], ':')

        const ledger = new LedgerStore(ledgersDir)
        const workspaces = new WorkspaceManager(workspacesRoot)
        const managerKey = `test::friend-cc-poc4` as ManagerKey

        const adaptersMap1 = new Map<WorkerImplId, WorkerAdapter>()
        const harness1 = new WorkerHarness({ adapters: adaptersMap1, defaultImpl: 'claude-code', ledger, workspaces, workersDir, now })
        const adapterA = new ClaudeCodeAdapter({ dataDir: ccDataDir, claudeConfigPath: join(dataDir, 'fake-claude.json'), claudeBin, onStateChange: harness1.handleStateChange })
        adaptersMap1.set('claude-code', adapterA)

        const worker = await harness1.spawnWorker({
          managerKey,
          title: 'PoC④ worker',
          prompt: '你好',
          origin: {
      trigger_type: 'message' },
          report_to: { channel_id: 'wechat', session_id: 'sess-1' },
          impl: 'claude-code',
        })

        await waitUntil(async () => {
          const terminal = await harness1.getWorkerTerminal(worker.worker_id)
          return terminal.kind === 'live_terminal' && terminal.text.includes('第一段输出')
        })

        // 绕开 adapter.kill,直接杀死 tmux 会话——模拟"agent 进程重启前,这个 worker 的 tmux
        // 会话已经先一步真死",台账此刻仍然认为它在 running(没人告诉它已经死了)。
        execFileSync('tmux', ['kill-session', '-t', `crabot-w-${worker.worker_id}-1`], { stdio: 'ignore' })

        const beforeRestart = await harness1.listWorkers(managerKey)
        expect(beforeRestart[0].task.status).toBe('running')
        expect(beforeRestart[0].incarnations[0].state).not.toBe('exited')

        // "重启":全新 harness + adapter,刻意不先调 reconcileOnStartup——只验证
        // sendToWorker 自己的透明接续(adapter.sendInput 抛 WorkerExitedError →
        // continueTerminalWorker → reviveIncarnation)能不能独立兜住这种场景。
        const adaptersMap2 = new Map<WorkerImplId, WorkerAdapter>()
        const harness2 = new WorkerHarness({ adapters: adaptersMap2, defaultImpl: 'claude-code', ledger, workspaces, workersDir, now })
        const adapterB = new ClaudeCodeAdapter({ dataDir: ccDataDir, claudeConfigPath: join(dataDir, 'fake-claude.json'), claudeBin, onStateChange: harness2.handleStateChange })
        adaptersMap2.set('claude-code', adapterB)

        await expect(harness2.sendToWorker(worker.worker_id, '接着办')).resolves.toBeUndefined()

        const [afterWorker] = await harness2.listWorkers(managerKey)
        expect(afterWorker.task.status).toBe('running')
        expect(afterWorker.incarnations).toHaveLength(2)
        expect(afterWorker.incarnations[0].state).toBe('exited')
        expect(afterWorker.incarnations[1].state).toBe('running')
        sessionsToCleanup.push(`crabot-w-${worker.worker_id}-${afterWorker.incarnations[1].seq}`)

        // 新化身真的在跑:wakeInput 送达 mock CLI,getWorkerTerminal(读主线=新化身)应该
        // 拿到新会话独立重跑一遍脚本产出的第一段输出。
        await waitUntil(async () => {
          const terminal = await harness2.getWorkerTerminal(worker.worker_id)
          return terminal.kind === 'live_terminal' && terminal.text.includes('第一段输出')
        })
      },
      20000,
    )
  },
)
