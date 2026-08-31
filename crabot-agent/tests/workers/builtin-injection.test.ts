/**
 * builtin worker 注入管道 + adapter 侧运行语义（PR F 第 1 步）。
 *
 * 覆盖 spec `2026-08-01-builtin-worker-injection-design.md` 的验收 1/2/3/5/6：
 *   1. manager 侧不传 `builtin` 也能拉起一个真的能干活的 builtin worker（真实 harness +
 *      真实 adapter + mock LLM，worker 真的执行一次工具调用）；
 *   2. 进程重启（丢弃内存态）后仍能 revive；
 *   3. 运行配置在每次起化身时现取——改了配置下次起化身生效，正在跑的 burst 用旧的；
 *   5. worker 的工作目录 = `spec.workspace`，`set_cwd` / goal 工具不得出现在工具集里；
 *   6. `hookRegistry` 确实生效——worker 在 Bash 里跑受禁 `crabot` 命令被拦下。
 *
 * 断的是语义不变量（worker 真的跑了/真的被拦了/真的用了新配置），不是"参数被透传了"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'node:crypto'

import { WorkerHarness, type HarnessDeps } from '../../src/workers/harness/harness'
import { LedgerStore } from '../../src/workers/harness/ledger-store'
import { WorkspaceManager } from '../../src/workers/harness/workspace-manager'
import { CLI_DOMAINS, type CliAccessConfig, type ResolvedPermissions, type ToolAccessConfig } from '../../src/types.js'
import { BuiltinWorkerAdapter } from '../../src/workers/builtin/adapter.js'
import {
  BUILTIN_WORKER_PERMISSIONS,
  narrowWorkerPermissions,
  type BuiltinRuntimeContext,
  type BuiltinRuntimeFactory,
} from '../../src/workers/builtin/runtime.js'
import type {
  WorkerImplId,
  WorkerAdapter,
  IncarnationHandle,
  IncarnationRef,
  SpawnSpec,
  Workspace,
  CapabilityBundle,
  DetectResult,
  WorkerContractState,
  AdapterCapabilities,
} from '../../src/workers/types'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import { defineTool } from '../../src/engine/index.js'

function forkOptions() {
  return {
    query_id: randomUUID(),
    establishment_deadline_at: new Date(Date.now() + 30_000).toISOString(),
  }
}
import type { ToolDefinition } from '../../src/engine/index.js'
import { createBashTool } from '../../src/engine/tools/bash-tool.js'
import { createSetCwdTool } from '../../src/engine/tools/set-cwd-tool.js'
import * as engineModule from '../../src/engine/query-loop.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

type Turn = {
  text?: string
  toolCalls?: Array<{ name: string; id: string; input: Record<string, unknown> }>
  stopReason: 'end_turn' | 'tool_use'
}

function makeLLM(responses: Turn[]): LLMAdapter {
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

async function waitUntil(cond: () => Promise<boolean> | boolean, timeoutMs = 8000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error('waitUntil timed out')
}

async function waitState(
  adapter: BuiltinWorkerAdapter,
  h: IncarnationHandle,
  target: WorkerContractState,
): Promise<void> {
  await waitUntil(async () => (await adapter.state(h)) === target)
}

/** 一个可探测的假工具，用于断言"worker 真的执行了一次工具调用"。 */
function makeProbeTool(onCall: () => void): ToolDefinition {
  return defineTool({
    name: 'probe',
    category: 'shell',
    description: 'probe',
    isReadOnly: true,
    inputSchema: { type: 'object', properties: {} },
    call: async () => {
      onCall()
      return { output: 'probe-ok', isError: false }
    },
  })
}

/**
 * 模仿真实调用方（harness.spawnWorker / handoffIncarnation）的注入方式：**spawn 的运行配置
 * 由调用方解析后放进 `spec.builtin`**，adapter 自己不再兜一次（两处回退会互相掩盖）。
 * resume / fork / idle→running 续 burst 没有 spec 可依，才由 adapter 调 `resolveRuntime`。
 */
async function spawnWith(
  adapter: BuiltinWorkerAdapter,
  factory: BuiltinRuntimeFactory,
  spec: Omit<SpawnSpec, 'builtin'>,
): Promise<IncarnationHandle> {
  const ctx: BuiltinRuntimeContext = {
    worker_id: spec.worker_id,
    workspace: spec.workspace,
    ...(spec.origin !== undefined ? { origin: spec.origin } : {}),
    ...(spec.goal !== undefined ? { goal: spec.goal } : {}),
  }
  return adapter.spawn({ ...spec, builtin: factory(ctx) })
}

const FINISH: Turn = {
  toolCalls: [{ name: 'finish_task', id: 'fin', input: { outcome: 'completed', summary: '完事' } }],
  stopReason: 'tool_use',
}

describe('builtin worker 注入管道（harness → 工厂回退）', () => {
  let dataDir: string
  let nowValue: number

  function now(): string {
    nowValue += 1000
    return new Date(nowValue).toISOString()
  }

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'builtin-injection-'))
    nowValue = Date.parse('2026-01-01T00:00:00.000Z')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  async function makeStack(factory: BuiltinRuntimeFactory) {
    const workspacesRoot = join(dataDir, 'workspaces')
    await fs.mkdir(workspacesRoot, { recursive: true })
    const adaptersMap = new Map<WorkerImplId, WorkerAdapter>()
    const deps: HarnessDeps = {
      adapters: adaptersMap,
      defaultImpl: 'builtin',
      ledger: new LedgerStore(join(dataDir, 'ledgers')),
      workspaces: new WorkspaceManager(workspacesRoot),
      workersDir: join(dataDir, 'workers'),
      now,
      builtinSpawnDefaults: factory,
    }
    const harness = new WorkerHarness(deps)
    const builtinAdapter = new BuiltinWorkerAdapter({
      dataDir: join(dataDir, 'builtin-adapter'),
      onStateChange: harness.handleStateChange,
      resolveRuntime: factory,
    })
    adaptersMap.set('builtin', builtinAdapter)
    return { harness, builtinAdapter, adaptersMap }
  }

  it('spawnWorker 不传 builtin → 回退到注入工厂，worker 真的跑起来并执行了一次工具调用', async () => {
    let probeCalls = 0
    const seen: BuiltinRuntimeContext[] = []
    const factory: BuiltinRuntimeFactory = (ctx) => {
      seen.push(ctx)
      return {
        adapter: makeLLM([
          { toolCalls: [{ name: 'probe', id: 'c1', input: {} }], stopReason: 'tool_use' },
          FINISH,
        ]),
        model: 'model-A',
        systemPrompt: '你是 worker',
        tools: [makeProbeTool(() => { probeCalls += 1 })],
      }
    }
    const { harness } = await makeStack(factory)

    const managerKey = (`test::${'friend-f1'}` as ManagerKey)
    const worker = await harness.spawnWorker({
      managerKey,
      title: '干活',
      prompt: '把活干完',
      origin: { spawned_by_episode: 'wechat::sess-1', trigger_type: 'message', creator_friend_id: 'friend-f1' },
      report_to: { channel_id: 'wechat', session_id: 'sess-1' },
      impl: 'builtin',
      goal: '目标',
      // 关键：不传 builtin —— manager 的 spawn_worker 工具就是这么调的。
    })

    expect(worker.task.status).toBe('running')
    await waitUntil(async () => {
      const [w] = await harness.listWorkers(managerKey)
      return w.task.status === 'halted'
    })

    // 语义不变量：worker 真的执行了工具调用、真的以 finish_task 收尾。
    expect(probeCalls).toBe(1)
    const [done] = await harness.listWorkers(managerKey)
    expect(done.incarnations[0].state).toBe('exited')
    expect(done.incarnations[0].ended_reason).toBe('completed')

    // 工厂拿到的是 per-worker 上下文，不是一个无参 thunk 能给的东西。
    expect(seen).toHaveLength(1)
    expect(seen[0].worker_id).toBe(worker.worker_id)
    expect(seen[0].workspace.root).toBe(done.incarnations[0].workspace)
    expect(seen[0].goal).toBe('目标')
    expect(seen[0].origin).toEqual({
      spawned_by_episode: 'wechat::sess-1',
      trigger_type: 'message',
      creator_friend_id: 'friend-f1',
    })
  })

  it('目标实现不是 builtin → 不调注入工厂（CLI adapter 忽略该字段）', async () => {
    const factory = vi.fn(() => undefined) as unknown as BuiltinRuntimeFactory
    const { harness, adaptersMap } = await makeStack(factory)

    const fakeCli: WorkerAdapter = {
      implId: 'claude-code',
      detect: async (): Promise<DetectResult> => ({ installed: true, activated: true }),
      provision: async (_ws: Workspace, _c: CapabilityBundle) => {},
      spawn: async (spec: SpawnSpec): Promise<IncarnationHandle> => ({
        worker_id: spec.worker_id, seq: 1, impl: 'claude-code', session_ref: 'sess',
      }),
      resume: async (prev: IncarnationRef): Promise<IncarnationHandle> => ({
        worker_id: prev.worker_id, seq: 2, impl: 'claude-code', session_ref: 'sess',
      }),
      fork: async (prev: IncarnationRef): Promise<IncarnationHandle> => ({
        worker_id: prev.worker_id, seq: 3, impl: 'claude-code', session_ref: 'sess',
      }),
      sendInput: async () => {},
      readTerminal: async () => ({ kind: 'unavailable' as const, unavailable_reason: 'headless_without_text' }),
      state: async (): Promise<WorkerContractState> => 'running',
      kill: async () => {},
      capabilities: (): AdapterCapabilities => ({ fork: true, revive: false, goalMode: false, subagent: false, structuredTrace: false }),
    }
    adaptersMap.set('claude-code', fakeCli)

    await harness.spawnWorker({
      managerKey: (`test::${'friend-f2'}` as ManagerKey),
      title: 'cc 干活',
      prompt: '干',
      origin: { spawned_by_episode: 'wechat::s', trigger_type: 'message' },
      report_to: { channel_id: 'wechat', session_id: 's' },
      impl: 'claude-code',
    })

    expect(factory).not.toHaveBeenCalled()
  })

  it('注入工厂抛错 → spawn 如实落成一次失败尝试（task failed + spawn_failed 事件），不静默', async () => {
    const factory: BuiltinRuntimeFactory = () => {
      throw new Error('model slot 未配置')
    }
    const { harness } = await makeStack(factory)
    const managerKey = (`test::${'friend-f3'}` as ManagerKey)

    await expect(
      harness.spawnWorker({
        managerKey,
        title: '干活',
        prompt: '干',
        origin: { spawned_by_episode: 'wechat::s', trigger_type: 'message' },
        report_to: { channel_id: 'wechat', session_id: 's' },
        impl: 'builtin',
      }),
    ).rejects.toThrow(/model slot 未配置/)

    const [w] = await harness.listWorkers(managerKey)
    expect(w.task.status).toBe('halted')
    expect(w.task.halt?.halt_reason).toBe('crashed')
    expect(w.incarnations[0].ended_reason).toBe('failed')
  })
})

describe('builtin worker 运行配置在起化身时现取', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'builtin-runtime-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  /** 工厂返回的 model 可变；每次被调用都记一笔 ctx。 */
  function makeMutableFactory(initialModel: string, llm: () => LLMAdapter) {
    const state = { model: initialModel, calls: [] as BuiltinRuntimeContext[] }
    const factory: BuiltinRuntimeFactory = (ctx) => {
      state.calls.push(ctx)
      return { adapter: llm(), model: state.model, systemPrompt: '', tools: [] }
    }
    return { state, factory }
  }

  it('进程重启（丢弃内存态）后仍能 revive —— 新 adapter 实例从 context.json 重建 ctx 并现取配置', async () => {
    const runEngineSpy = vi.spyOn(engineModule, 'runEngine')
    const { state, factory } = makeMutableFactory('model-A', () => makeLLM([FINISH]))
    const workerId = `w-${randomUUID()}`
    const workspace = { root: join(dataDir, 'ws') }
    await fs.mkdir(workspace.root, { recursive: true })

    const first = new BuiltinWorkerAdapter({ dataDir, resolveRuntime: factory })
    const h1 = await spawnWith(first, factory, {
      worker_id: workerId,
      prompt: '干活',
      workspace,
      origin: { spawned_by_episode: 'wechat::s1', trigger_type: 'message' },
    })
    await waitState(first, h1, 'exited')

    // ---- 模拟进程重启：换一个全新的 adapter 实例（内存 instances / 配置表全空），
    //      只有磁盘和挂在装配层上的工厂还在。
    state.model = 'model-B'
    const restarted = new BuiltinWorkerAdapter({ dataDir, resolveRuntime: factory })
    const meta1 = JSON.parse(await fs.readFile(join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
    const h2 = await restarted.resume(
      { worker_id: workerId, seq: 1, session_ref: meta1.tip_node_id },
      '接着干',
    )
    expect(h2.seq).toBe(2)
    await waitState(restarted, h2, 'exited')

    // 现取：revive 用的是工厂**当下**返回的配置，不是重启前那份快照。
    const models = runEngineSpy.mock.calls.map((c) => c[0].options.model)
    expect(models).toEqual(['model-A', 'model-B'])

    // ctx 从 context.json 重建：workspace / origin 与 spawn 时一致。
    const reviveCtx = state.calls[state.calls.length - 1]
    expect(reviveCtx.worker_id).toBe(workerId)
    expect(reviveCtx.workspace.root).toBe(workspace.root)
    expect(reviveCtx.origin).toEqual({ spawned_by_episode: 'wechat::s1', trigger_type: 'message' })
  })

  it('改了配置下次起化身生效，正在跑的 burst 用旧的（多轮 burst 内工厂只调一次）', async () => {
    const runEngineSpy = vi.spyOn(engineModule, 'runEngine')
    // 第一次 burst 两轮（工具调用 + end_turn），用于验证 burst 内不会反复现取。
    const { state, factory } = makeMutableFactory('model-A', () =>
      makeLLM([
        { text: '第一轮', stopReason: 'end_turn' },
        { text: '第二轮', stopReason: 'end_turn' },
      ]),
    )
    const workerId = `w-${randomUUID()}`
    const adapter = new BuiltinWorkerAdapter({ dataDir, resolveRuntime: factory })
    const h = await spawnWith(adapter, factory, { worker_id: workerId, prompt: '干活', workspace: { root: dataDir } })
    await waitState(adapter, h, 'idle')
    expect(state.calls).toHaveLength(1)

    // 改配置：不影响已经落定的这一化身当前 burst，下一次起 burst 才现取。
    state.model = 'model-B'
    await adapter.sendInput(h, '继续')
    await waitState(adapter, h, 'idle')

    expect(state.calls).toHaveLength(2)
    const models = runEngineSpy.mock.calls.map((c) => c[0].options.model)
    expect(models).toEqual(['model-A', 'model-B'])
  })

  it('fork 也现取运行配置', async () => {
    const runEngineSpy = vi.spyOn(engineModule, 'runEngine')
    const { state, factory } = makeMutableFactory('model-A', () => makeLLM([{ text: 'ok', stopReason: 'end_turn' }]))
    const workerId = `w-${randomUUID()}`
    const adapter = new BuiltinWorkerAdapter({ dataDir, resolveRuntime: factory })
    const h = await spawnWith(adapter, factory, { worker_id: workerId, prompt: '干活', workspace: { root: dataDir } })
    await waitState(adapter, h, 'idle')

    state.model = 'model-B'
    const forkHandle = await adapter.fork({ worker_id: workerId, seq: 1, session_ref: h.session_ref }, '侧问一句', forkOptions())
    await waitState(adapter, forkHandle, 'exited')

    const models = runEngineSpy.mock.calls.map((c) => c[0].options.model)
    expect(models).toEqual(['model-A', 'model-B'])
  })

  it('未配置工厂时退化为 spawn 时的内存快照（契约套件/单测路径），但跨实例不可用', async () => {
    const workerId = `w-${randomUUID()}`
    const adapter = new BuiltinWorkerAdapter({ dataDir })
    const h = await adapter.spawn({
      worker_id: workerId,
      prompt: '干活',
      workspace: { root: dataDir },
      builtin: { adapter: makeLLM([FINISH]), model: 'model-A', systemPrompt: '', tools: [] },
    })
    await waitState(adapter, h, 'exited')

    const restarted = new BuiltinWorkerAdapter({ dataDir })
    const meta1 = JSON.parse(await fs.readFile(join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
    await expect(
      restarted.resume({ worker_id: workerId, seq: 1, session_ref: meta1.tip_node_id }, '接着干'),
    ).rejects.toThrow(/no builtin config resident in memory/)
  })
})

describe('builtin worker 的 workspace 与工具集守卫', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'builtin-ws-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('工作目录 = spec.workspace，落 context.json；工具的 cwd 就是它', async () => {
    const workspace = { root: join(dataDir, 'ws') }
    await fs.mkdir(workspace.root, { recursive: true })
    const workerId = `w-${randomUUID()}`
    let seenCwd = ''
    const factory: BuiltinRuntimeFactory = (ctx) => ({
      adapter: makeLLM([{ toolCalls: [{ name: 'probe', id: 'c1', input: {} }], stopReason: 'tool_use' }, FINISH]),
      model: 'm',
      systemPrompt: '',
      // 装配层用 ctx.workspace.root 作为工具的 cwd —— 这是"workspace 即 cwd"的落点。
      tools: [
        defineTool({
          name: 'probe',
          category: 'shell',
          description: 'probe',
          isReadOnly: true,
          inputSchema: { type: 'object', properties: {} },
          call: async () => {
            seenCwd = ctx.workspace.root
            return { output: 'ok', isError: false }
          },
        }),
      ],
    })

    const adapter = new BuiltinWorkerAdapter({ dataDir, resolveRuntime: factory })
    const h = await spawnWith(adapter, factory, { worker_id: workerId, prompt: '干活', workspace })
    await waitState(adapter, h, 'exited')

    expect(seenCwd).toBe(workspace.root)
    const persisted = JSON.parse(await fs.readFile(join(dataDir, workerId, 'context.json'), 'utf-8'))
    expect(persisted.workspace.root).toBe(workspace.root)
  })

  it('工具集里出现 set_cwd → fail-loud，化身落 exited(crashed)', async () => {
    const workerId = `w-${randomUUID()}`
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    const factory: BuiltinRuntimeFactory = () => ({
      adapter: makeLLM([FINISH]),
      model: 'm',
      systemPrompt: '',
      tools: [createSetCwdTool({ getCwd: () => dataDir, setCwd: () => {} })],
    })
    const adapter = new BuiltinWorkerAdapter({ dataDir, resolveRuntime: factory })
    const h = await spawnWith(adapter, factory, { worker_id: workerId, prompt: '干活', workspace: { root: dataDir } })
    await waitState(adapter, h, 'exited')

    const meta = JSON.parse(await fs.readFile(join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
    expect(meta.ended_reason).toBe('crashed')
    expect(errors.join('\n')).toContain('set_cwd')
  })

  it('工具集里出现 goal 工具（set_task_goal）→ 同样 fail-loud', async () => {
    const workerId = `w-${randomUUID()}`
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    const factory: BuiltinRuntimeFactory = () => ({
      adapter: makeLLM([FINISH]),
      model: 'm',
      systemPrompt: '',
      tools: [
        defineTool({
          name: 'set_task_goal',
          description: 'goal',
          isReadOnly: false,
          inputSchema: { type: 'object', properties: {} },
          call: async () => ({ output: '', isError: false }),
        }),
      ],
    })
    const adapter = new BuiltinWorkerAdapter({ dataDir, resolveRuntime: factory })
    const h = await spawnWith(adapter, factory, { worker_id: workerId, prompt: '干活', workspace: { root: dataDir } })
    await waitState(adapter, h, 'exited')

    const meta = JSON.parse(await fs.readFile(join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
    expect(meta.ended_reason).toBe('crashed')
    expect(errors.join('\n')).toContain('set_task_goal')
  })
})

describe('builtin worker 的安全项（hookRegistry / 权限档位）', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'builtin-safety-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('worker 在 Bash 里跑受禁的 crabot 命令 → 被 CLI 权限闸拦下，命令没有真的执行', async () => {
    const workerId = `w-${randomUUID()}`
    const marker = join(dataDir, 'should-not-exist.txt')
    const factory: BuiltinRuntimeFactory = () => ({
      adapter: makeLLM([
        {
          toolCalls: [{
            name: 'Bash',
            id: 'c1',
            // 未识别的 crabot 子命令 → cli-permission-gate fail-closed 拦截。
            // `&& touch` 是探针：命令若真的执行了，marker 文件会出现。
            input: { command: `crabot zzz-not-a-real-subcommand && touch ${marker}` },
          }],
          stopReason: 'tool_use',
        },
        FINISH,
      ]),
      model: 'm',
      systemPrompt: '',
      tools: [createBashTool(() => dataDir)],
    })

    const adapter = new BuiltinWorkerAdapter({ dataDir, resolveRuntime: factory })
    const h = await spawnWith(adapter, factory, { worker_id: workerId, prompt: '干活', workspace: { root: dataDir } })
    await waitState(adapter, h, 'exited')

    // 拦截结果进了会话（tool_result），worker 看得见被拒的理由。
    const session = await fs.readFile(join(dataDir, workerId, 'session.jsonl'), 'utf-8')
    expect(session).toContain('PERMISSION_DENIED')
    // 且命令确实没跑起来。
    await expect(fs.access(marker)).rejects.toThrow()
  })

  it('权限档位真的过滤工具：messaging 类被拒、shell 类放行、finish_task 恒放行', async () => {
    const runEngineSpy = vi.spyOn(engineModule, 'runEngine')
    const workerId = `w-${randomUUID()}`
    const messagingTool = defineTool({
      name: 'send_message',
      category: 'messaging',
      description: 'send',
      isReadOnly: false,
      inputSchema: { type: 'object', properties: {} },
      call: async () => ({ output: 'sent', isError: false }),
    })
    const factory: BuiltinRuntimeFactory = () => ({
      adapter: makeLLM([
        { toolCalls: [{ name: 'send_message', id: 'c1', input: {} }], stopReason: 'tool_use' },
        FINISH,
      ]),
      model: 'm',
      systemPrompt: '',
      tools: [messagingTool, makeProbeTool(() => {})],
    })
    const adapter = new BuiltinWorkerAdapter({ dataDir, resolveRuntime: factory })
    const h = await spawnWith(adapter, factory, { worker_id: workerId, prompt: '干活', workspace: { root: dataDir } })
    await waitState(adapter, h, 'exited')

    // 语义不变量：worker 想说话 → 被权限档位挡下，会话里留下拒绝理由。
    const session = await fs.readFile(join(dataDir, workerId, 'session.jsonl'), 'utf-8')
    expect(session).toContain('Permission denied')

    const permissionConfig = runEngineSpy.mock.calls[0][0].options.permissionConfig
    expect(permissionConfig).toBeDefined()
    const check = permissionConfig!.checkPermission!
    expect((await check('send_message', {})).allowed).toBe(false)
    expect((await check('probe', {})).allowed).toBe(true)
    expect((await check('finish_task', {})).allowed).toBe(true)
  })

  it('runEngine 每次都带上 hookRegistry / 固定权限档位 / 模型参数（fork 的一次性 burst 也一样）', async () => {
    const runEngineSpy = vi.spyOn(engineModule, 'runEngine')
    const workerId = `w-${randomUUID()}`
    const factory: BuiltinRuntimeFactory = () => ({
      adapter: makeLLM([{ text: 'ok', stopReason: 'end_turn' }]),
      model: 'm',
      systemPrompt: '',
      tools: [],
      maxTokens: 4096,
      contextWindowTokens: 123456,
      supportsVision: true,
      timezone: 'Asia/Shanghai',
    })
    const adapter = new BuiltinWorkerAdapter({ dataDir, resolveRuntime: factory })
    const h = await spawnWith(adapter, factory, { worker_id: workerId, prompt: '干活', workspace: { root: dataDir } })
    await waitState(adapter, h, 'idle')
    const forkHandle = await adapter.fork({ worker_id: workerId, seq: 1, session_ref: h.session_ref }, '侧问', forkOptions())
    await waitState(adapter, forkHandle, 'exited')

    expect(runEngineSpy.mock.calls).toHaveLength(2)
    for (const call of runEngineSpy.mock.calls) {
      const options = call[0].options
      expect(options.hookRegistry?.isEmpty()).toBe(false)
      expect(options.resolvedPermissions).toBe(BUILTIN_WORKER_PERMISSIONS)
      // F 阶段没有可信发起人身份，不能走 CLI 闸的 master 短路。
      expect(options.senderIsMaster).toBe(false)
      expect(options.maxTokens).toBe(4096)
      expect(options.contextWindowTokens).toBe(123456)
      expect(options.supportsVision).toBe(true)
      expect(options.timezone).toBe('Asia/Shanghai')
    }
  })

  it('固定权限档位：Memory 与控制面关闭，文件/Shell/Skill 干活面开启', () => {
    expect(Object.values(BUILTIN_WORKER_PERMISSIONS.cli_access).every((v) => v === 'none')).toBe(true)
    expect(BUILTIN_WORKER_PERMISSIONS.tool_access).toMatchObject({
      messaging: false,
      task: false,
      remote_exec: false,
      desktop: false,
      file_io: true,
      shell: true,
      memory: false,
      mcp_skill: true,
    })
  })
})

// ============================================================================
// P7 J Task 2：worker 权限 = 固定档位 ∩ 派活人档位
// ============================================================================

/**
 * "manager 算好结果随 spawn 下传"的合并规则（`narrowWorkerPermissions`）。
 *
 * 这条规则同时要挡住两个方向的越权，所以两侧都要有反向用例：
 * 只用发起人档位 ⇒ worker 拿到 messaging（违反 v3"worker 不跟人类说话"）；
 * 只用固定档位 ⇒ 群里任何人派出的 worker 都拿到同一套 shell/file_io（PR F spec 点名的越权）。
 */
describe('narrowWorkerPermissions —— worker 档位 ∩ 派活人档位', () => {
  function perms(p: {
    tool?: Partial<ToolAccessConfig>
    cli?: 'none' | 'read' | 'write'
    scopes?: string[]
  }): ResolvedPermissions {
    return {
      tool_access: {
        memory: true, messaging: true, task: true, mcp_skill: true,
        file_io: true, browser: true, shell: true, remote_exec: true, desktop: true,
        ...p.tool,
      },
      cli_access: Object.fromEntries(CLI_DOMAINS.map((d) => [d, p.cli ?? 'write'])) as CliAccessConfig,
      storage: null,
      memory_scopes: p.scopes ?? [],
    }
  }

  it('派活人没有 shell → worker 也没有 shell（这正是 PR F spec 要 J 修掉的越权）', () => {
    const out = narrowWorkerPermissions(BUILTIN_WORKER_PERMISSIONS, perms({ tool: { shell: false } }))
    expect(out.tool_access.shell).toBe(false)
    // 其余干活面不受牵连
    expect(out.tool_access.file_io).toBe(true)
  })

  it('派活人是 master（全开）→ worker 仍然拿不到 messaging / task：v3 不变量优先于发起人档位', () => {
    const out = narrowWorkerPermissions(BUILTIN_WORKER_PERMISSIONS, perms({}))
    expect(out.tool_access.messaging).toBe(false)
    expect(out.tool_access.task).toBe(false)
    expect(out.tool_access.remote_exec).toBe(false)
    expect(out.tool_access.desktop).toBe(false)
  })

  it('cli_access 取更严的一档：派活人 write、worker 固定 none → 结果 none', () => {
    const out = narrowWorkerPermissions(BUILTIN_WORKER_PERMISSIONS, perms({ cli: 'write' }))
    expect(Object.values(out.cli_access).every((v) => v === 'none')).toBe(true)
  })

  it('memory_scopes 保留身份快照，但不能重新开放 Worker Memory', () => {
    const out = narrowWorkerPermissions(BUILTIN_WORKER_PERMISSIONS, perms({ scopes: ['team-x'] }))
    expect(out.memory_scopes).toEqual(['team-x'])
    expect(out.tool_access.memory).toBe(false)
  })

  it('身份未解析（null）→ 原样退回固定档位，与 F 阶段行为逐字相同', () => {
    expect(narrowWorkerPermissions(BUILTIN_WORKER_PERMISSIONS, null)).toBe(BUILTIN_WORKER_PERMISSIONS)
  })

  it('不改写入参：合并结果是新对象，固定档位常量不被污染', () => {
    const before = JSON.stringify(BUILTIN_WORKER_PERMISSIONS)
    narrowWorkerPermissions(BUILTIN_WORKER_PERMISSIONS, perms({ scopes: ['x'], cli: 'write' }))
    expect(JSON.stringify(BUILTIN_WORKER_PERMISSIONS)).toBe(before)
  })
})
