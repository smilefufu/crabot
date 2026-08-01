/**
 * builtin worker 的**生产装配**（PR F 第 2 步）——spec
 * `2026-08-01-builtin-worker-injection-design.md`。
 *
 * 第 1 步（`builtin-injection.test.ts`）用测试自己造的 fake 工厂验管道；本文件反过来：走
 * **真实 `UnifiedAgent` 构造函数装配出的 manager 栈**（真实 harness + 真实
 * `BuiltinWorkerAdapter` + 真实注入工厂 `buildBuiltinWorkerRuntime` + 真实工具/prompt 组装），
 * 只把 LLM 换成脚本化 mock（`adapterFromSdkEnv` 是整条链路上唯一的 LLM 入口）。
 *
 * 覆盖 spec 验收：
 *   1. manager 侧不传 `builtin` → 真的拉起一个能干活的 builtin worker（真的执行工具调用）；
 *   2. 进程重启（换一个 UnifiedAgent 实例，内存态全丢）后 revive 仍可用；
 *   3. 改 model slot 后起的新化身用新配置，已经起好的化身不受影响；
 *   4. worker 工具集不含 messaging / `set_cwd` / goal 相关（逐项断言）；
 *   5. 工作目录 = `spec.workspace`，且没有任何切换工作目录的工具；
 *   6. `hookRegistry` 生效——Bash 里跑受禁 `crabot` 命令被拦。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { UnifiedAgent } from '../../src/unified-agent.js'
import * as agentHandlerModule from '../../src/agent/agent-handler.js'
import * as engineModule from '../../src/engine/query-loop.js'
import { dialogObjectIdForPrivate, type DialogObjectId } from '../../src/workers/harness/ledger-types.js'
import type { ManagerStack } from '../../src/manager/bootstrap.js'
import type { LLMAdapter, ToolDefinition } from '../../src/engine/index.js'
import type {
  UnifiedAgentConfig,
  OrchestrationConfig,
  LLMConnectionInfo,
  ModuleId,
  SkillConfig,
} from '../../src/types.js'
import { BUILTIN_WORKER_PERMISSIONS, type BuiltinRuntimeContext } from '../../src/workers/builtin/runtime.js'
import type { SpawnSpec } from '../../src/workers/types.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

// ============================================================================
// helpers
// ============================================================================

const ORCHESTRATION: OrchestrationConfig = {
  front_context_recent_messages_window_hours: 24,
  front_context_recent_messages_max_cap: 50,
  front_context_short_term_memory_window_hours: 24,
  front_context_short_term_memory_max_cap: 20,
  worker_recent_messages_window_hours: 24,
  worker_recent_messages_max_cap: 50,
  worker_short_term_memory_window_hours: 24,
  worker_short_term_memory_max_cap: 20,
  worker_long_term_memory_limit: 10,
  front_agent_timeout: 60,
  session_state_ttl: 3600,
  worker_config_refresh_interval: 300,
  front_agent_queue_max_length: 10,
  front_agent_queue_timeout: 60,
}

function connInfo(modelId: string): LLMConnectionInfo {
  return { endpoint: 'https://example.invalid', apikey: 'k', model_id: modelId, format: 'anthropic' }
}

/**
 * `roles: []` 与 `p5-integration.test.ts` 同理：带 'worker' 角色会建 AgentHandler 并起 LSP
 * 子进程，与 builtin worker 的注入通道无关。builtin 的运行配置工厂**不看 roles**，它直接读
 * `model_config.powerful`——这也是本文件顺带钉住的性质。
 */
function makeConfig(p: {
  modelConfig?: Record<string, LLMConnectionInfo>
  systemPrompt?: string
  skills?: SkillConfig[]
  tmpPageBaseUrl?: string
}): UnifiedAgentConfig {
  return {
    module_id: 'p7f-runtime-agent' as ModuleId,
    module_type: 'agent',
    version: '0.0.0-test',
    protocol_version: '1.0',
    port: 19998,
    orchestration: ORCHESTRATION,
    agent_config: {
      instance_id: 'p7f',
      roles: [],
      system_prompt: p.systemPrompt ?? '你是测试用 Crabot',
      model_config: p.modelConfig ?? { powerful: connInfo('model-A') },
      ...(p.skills ? { skills: p.skills } : {}),
      ...(p.tmpPageBaseUrl ? { tmp_page_base_url: p.tmpPageBaseUrl } : {}),
    },
  }
}

interface Turn {
  readonly text?: string
  readonly toolCalls?: ReadonlyArray<{ name: string; id: string; input: Record<string, unknown> }>
  readonly stopReason: 'end_turn' | 'tool_use'
}

/**
 * mock LLM 区分 worker burst 与 manager episode 的锚点。
 *
 * 取 `finish_task` 而不是契约尾巴的某句措辞：措辞会被反复打磨（这个常量已经因此坏过一次），
 * 但"`finish_task` 是 builtin worker 的终态信号、必须在 system prompt 里交代给它"是
 * protocol-agent-v3 §5.1（finalize 即 exited）规定的不变量，而 manager 没有也不该有这个
 * 工具（§4.3 的封闭白名单）。全仓 system prompt 里唯一写出这个词的地方就是 worker 契约
 * 尾巴（`unified-agent.ts` 的 `buildBuiltinWorkerContractPrompt`）。
 *
 * 下面"systemPrompt = 现网 agent prompt + v3 worker 契约尾巴"那条用例复用同一个常量断言它
 * 确实在 prompt 里——锚点一旦从 prompt 里消失，那条用例先炸，而不是靠本文件的脚本被
 * manager 抢走这种间接症状去发现。
 */
const WORKER_PROMPT_MARKER = 'finish_task'

const FINISH: Turn = {
  toolCalls: [{ name: 'finish_task', id: 'fin', input: { outcome: 'completed', summary: '完事' } }],
  stopReason: 'tool_use',
}

/**
 * 队列驱动的 mock LLM：整条生产链路上唯一被替换的件。
 *
 * **按 system prompt 分流**：harness 的事件会经 `onEvent` 唤醒真实的 manager loop（生产接线，
 * 不该为了测试拆掉），而 manager 与 builtin worker 走的是同一个 `adapterFromSdkEnv` 出口。
 * 不分流的话 manager 会抢走给 worker 排的脚本——`WORKER_PROMPT_MARKER`（见其注释）是两者
 * system prompt 上稳定且语义正确的分界。manager 一律一句话收工，不干扰任何断言。
 */
function makeScriptedLLM(): { adapter: LLMAdapter; queue: Turn[] } {
  const queue: Turn[] = []
  const adapter = {
    stream: vi.fn(async function* (params: { systemPrompt: string }) {
      const isWorker = params.systemPrompt.includes(WORKER_PROMPT_MARKER)
      const r = isWorker
        ? queue.shift() ?? { text: '(没有脚本了)', stopReason: 'end_turn' as const }
        : { text: '(manager 收到，无动作)', stopReason: 'end_turn' as const }
      const content: unknown[] = []
      if (r.text) content.push({ type: 'text', text: r.text })
      for (const tc of r.toolCalls ?? []) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      yield* chunksFromContent(content, r.stopReason, { inputTokens: 10, outputTokens: 5 })
    }),
    updateConfig: () => {},
  } as unknown as LLMAdapter
  return { adapter, queue }
}

/** builtin worker 那一轮 burst 的 runEngine 调用（manager loop 的调用不带固定权限档位）。 */
function workerBurstModels(spy: { mock: { calls: Array<[{ options: { model: string; resolvedPermissions?: unknown } }]> } }): string[] {
  return spy.mock.calls
    .filter((c) => c[0].options.resolvedPermissions === BUILTIN_WORKER_PERMISSIONS)
    .map((c) => c[0].options.model)
}

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 8000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('waitUntil timed out')
}

/** UnifiedAgent 私有件在测试里的视图（TS 私有性只在编译期）。 */
interface AgentInternals {
  managerStack?: ManagerStack
  methodHandlers: Map<string, (params: unknown) => unknown>
  adminPort?: number
  buildBuiltinWorkerRuntime(ctx: BuiltinRuntimeContext): SpawnSpec['builtin']
}

function resolveTools(builtin: NonNullable<SpawnSpec['builtin']>): ReadonlyArray<ToolDefinition> {
  const t = builtin.tools
  return typeof t === 'function' ? t() : t
}

function resolvePrompt(builtin: NonNullable<SpawnSpec['builtin']>): string {
  const p = builtin.systemPrompt
  return typeof p === 'function' ? p() : p
}

// ============================================================================

describe('builtin worker 生产装配（PR F 第 2 步）', () => {
  let tmpRoot: string
  let prevDataDir: string | undefined
  let prevAgentDataDir: string | undefined
  let llm: ReturnType<typeof makeScriptedLLM>

  function boot(config: UnifiedAgentConfig = makeConfig({})): { agent: UnifiedAgent; internals: AgentInternals } {
    const agent = new UnifiedAgent(config)
    const internals = agent as unknown as AgentInternals
    internals.adminPort = 1
    return { agent, internals }
  }

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(join(tmpdir(), 'p7f-runtime-'))
    prevDataDir = process.env.DATA_DIR
    prevAgentDataDir = process.env.CRABOT_AGENT_DATA_DIR
    delete process.env.CRABOT_AGENT_DATA_DIR
    process.env.DATA_DIR = join(tmpRoot, 'data')
    llm = makeScriptedLLM()
    // 生产链路上唯一被替换的件：`adapterFromSdkEnv` 是 unified-agent 把 model slot 变成
    // 真会发 HTTP 的 adapter 的唯一出口（manager 与 builtin worker 共用它）。
    vi.spyOn(agentHandlerModule, 'adapterFromSdkEnv').mockReturnValue(llm.adapter as never)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (prevDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = prevDataDir
    if (prevAgentDataDir === undefined) delete process.env.CRABOT_AGENT_DATA_DIR
    else process.env.CRABOT_AGENT_DATA_DIR = prevAgentDataDir
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  async function spawnBuiltin(
    internals: AgentInternals,
    dialogObjectId: DialogObjectId,
    prompt = '把活干完',
  ): Promise<{ workerId: string; workspace: string }> {
    const harness = internals.managerStack!.harness
    // 关键：**不传 `builtin`** —— manager 的 `spawn_worker` 工具就是这么调 harness 的。
    const worker = await harness.spawnWorker({
      dialogObjectId,
      title: '干活',
      prompt,
      origin: { spawned_by_session: 'wechat::sess-1', trigger_type: 'message', creator_friend_id: 'friend-f1' },
      report_to: { channel_id: 'wechat' as ModuleId, session_id: 'sess-1' },
      impl: 'builtin',
    })
    return { workerId: worker.worker_id, workspace: worker.incarnations[0].workspace }
  }

  // --- 验收 1 + 5：端到端拉起 + 工作目录就是 workspace ---

  it('验收 1/5：manager 不传 builtin → 真的拉起 worker，worker 真的执行了一次工具调用，且 cwd = spec.workspace', async () => {
    const { internals } = boot()
    llm.queue.push(
      { toolCalls: [{ name: 'Bash', id: 'c1', input: { command: 'pwd > pwd.txt' } }], stopReason: 'tool_use' },
      FINISH,
    )

    const dialogObjectId = dialogObjectIdForPrivate('friend-f1')
    const { workspace } = await spawnBuiltin(internals, dialogObjectId)

    await waitUntil(async () => {
      const [w] = await internals.managerStack!.harness.listWorkers(dialogObjectId)
      return w.task.status === 'completed'
    })

    // 语义不变量：工具真的执行了（文件真的被写出来），而且是在 workspace 里执行的。
    const pwd = (await fs.readFile(join(workspace, 'pwd.txt'), 'utf-8')).trim()
    expect(pwd).toBe(await fs.realpath(workspace))

    const [done] = await internals.managerStack!.harness.listWorkers(dialogObjectId)
    expect(done.incarnations[0].ended_reason).toBe('completed')
  })

  // --- 验收 6：hookRegistry 在生产路径上确实生效 ---

  it('验收 6：worker 在 Bash 里跑受禁 crabot 命令 → 被 CLI 权限闸拦下，命令没有真的执行', async () => {
    const { internals } = boot()
    const marker = join(tmpRoot, 'should-not-exist.txt')
    llm.queue.push(
      {
        // 未识别的 crabot 子命令 → cli-permission-gate fail-closed；`&& touch` 是探针。
        toolCalls: [{ name: 'Bash', id: 'c1', input: { command: `crabot zzz-not-a-real-subcommand && touch ${marker}` } }],
        stopReason: 'tool_use',
      },
      FINISH,
    )

    const dialogObjectId = dialogObjectIdForPrivate('friend-hook')
    const { workerId } = await spawnBuiltin(internals, dialogObjectId)
    await waitUntil(async () => {
      const [w] = await internals.managerStack!.harness.listWorkers(dialogObjectId)
      return w.task.status === 'completed'
    })

    const sessionPath = join(internals.managerStack!.builtinDataDir, workerId, 'session.jsonl')
    expect(await fs.readFile(sessionPath, 'utf-8')).toContain('PERMISSION_DENIED')
    await expect(fs.access(marker)).rejects.toThrow()
  })

  // --- 验收 4 + 5：工具集逐项断言 ---

  describe('验收 4/5：worker 的工具集', () => {
    const skills: SkillConfig[] = [{ name: 'demo-skill', description: '演示技能', skill_dir: '/tmp/skills/demo' }]

    function toolNames(internals: AgentInternals, workspaceRoot: string): string[] {
      const builtin = internals.buildBuiltinWorkerRuntime({
        worker_id: 'w-tools',
        workspace: { root: workspaceRoot },
        origin: { spawned_by_session: 'wechat::s', trigger_type: 'message' },
      })!
      return resolveTools(builtin).map((t) => t.name)
    }

    it('装了干活必需的四类：文件/shell + skills、crab-memory、tmp-page（外部 MCP 未连接时为空）', () => {
      const { internals } = boot(makeConfig({ skills, tmpPageBaseUrl: 'https://example.test' }))
      const names = toolNames(internals, tmpRoot)

      for (const n of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill']) {
        expect(names, `应装 ${n}`).toContain(n)
      }
      expect(names).toContain('mcp__crab-memory__store_memory')
      expect(names).toContain('mcp__crab-memory__search_memory')
      expect(names).toContain('tmp_page_create')
    })

    it('不含 messaging / set_cwd / goal 相关，也不含本阶段明确排除的那几个（逐项断言）', () => {
      const { internals } = boot(makeConfig({ skills }))
      const names = toolNames(internals, tmpRoot)

      // messaging 整面（v3：worker 不直接跟人类说话）
      for (const n of [
        'mcp__crab-messaging__send_message',
        'mcp__crab-messaging__get_message',
        'mcp__crab-messaging__read_feishu_document',
        'send_message',
      ]) {
        expect(names, `不该装 ${n}`).not.toContain(n)
      }
      expect(names.filter((n) => n.startsWith('mcp__crab-messaging__'))).toEqual([])
      // 工作目录不可中途切换（决策 3）
      expect(names).not.toContain('set_cwd')
      // goal 相关（决策 4）
      expect(names).not.toContain('set_task_goal')
      // 本阶段排除项
      for (const n of [
        'delegate_task', 'todo', 'find_task', 'get_task_progress', 'wait_for_signal',
        'list_active_subagents', 'get_subagent_output', 'stop_subagent', 'request_restart',
      ]) {
        expect(names, `不该装 ${n}`).not.toContain(n)
      }
    })

    it('工具的 cwd 恒等于 ctx.workspace.root（换一个 workspace 就换一个 cwd）', async () => {
      const { internals } = boot()
      const wsA = join(tmpRoot, 'ws-a')
      const wsB = join(tmpRoot, 'ws-b')
      await fs.mkdir(wsA, { recursive: true })
      await fs.mkdir(wsB, { recursive: true })

      for (const ws of [wsA, wsB]) {
        const builtin = internals.buildBuiltinWorkerRuntime({ worker_id: 'w-cwd', workspace: { root: ws } })!
        const bash = resolveTools(builtin).find((t) => t.name === 'Bash')!
        const res = await bash.call({ command: 'pwd' }, { signal: new AbortController().signal })
        expect(String(res.output).trim()).toContain(await fs.realpath(ws))
      }
    })
  })

  // --- 验收 3：运行配置现取 ---

  it('验收 3：改 model slot 后起的新化身用新配置；已经起好的化身用的还是旧的', async () => {
    const runEngineSpy = vi.spyOn(engineModule, 'runEngine')
    const { internals } = boot()

    // 第一个 worker：跑一轮 end_turn 就停在 idle（化身还活着）。
    llm.queue.push({ text: '先歇着', stopReason: 'end_turn' })
    const objA = dialogObjectIdForPrivate('friend-a')
    await spawnBuiltin(internals, objA)
    await waitUntil(async () => {
      const [w] = await internals.managerStack!.harness.listWorkers(objA)
      return w.incarnations[0].state === 'idle'
    })
    expect(workerBurstModels(runEngineSpy)).toEqual(['model-A'])

    // 经真实 update_config RPC 改 model slot。
    const updateConfig = internals.methodHandlers.get('update_config')!
    await updateConfig({ model_config: { powerful: connInfo('model-B') } })

    // 已经起好的那个化身不受影响：它那次 burst 仍记 model-A，没有被追溯改写。
    expect(workerBurstModels(runEngineSpy)).toEqual(['model-A'])

    // 新起的化身现取到 model-B。
    llm.queue.push(FINISH)
    const objB = dialogObjectIdForPrivate('friend-b')
    await spawnBuiltin(internals, objB)
    await waitUntil(async () => {
      const [w] = await internals.managerStack!.harness.listWorkers(objB)
      return w.task.status === 'completed'
    })
    expect(workerBurstModels(runEngineSpy)).toEqual(['model-A', 'model-B'])
  })

  // --- 验收 2：重启后 revive ---

  it('验收 2：换一个 UnifiedAgent 实例（内存态全丢）后，send_to_worker 仍能透明接续已终态的 worker', async () => {
    const { internals: first } = boot()
    llm.queue.push(FINISH)
    const dialogObjectId = dialogObjectIdForPrivate('friend-revive')
    const { workerId } = await spawnBuiltin(first, dialogObjectId)
    await waitUntil(async () => {
      const [w] = await first.managerStack!.harness.listWorkers(dialogObjectId)
      return w.task.status === 'completed'
    })

    // ---- 模拟进程重启：同一个 DATA_DIR 上重新装配一整套栈，内存里的 instances / 配置表全空。
    const { internals: restarted } = boot()
    llm.queue.push(FINISH)
    await restarted.managerStack!.harness.sendToWorker(workerId, '接着干')

    const [revived] = await restarted.managerStack!.harness.listWorkers(dialogObjectId)
    // 新化身由重启后那套栈的注入工厂现取配置拉起来（seq=2），任务被接续。
    expect(revived.incarnations).toHaveLength(2)
    expect(revived.incarnations[1].seq).toBe(2)
    await waitUntil(async () => {
      const [w] = await restarted.managerStack!.harness.listWorkers(dialogObjectId)
      return w.incarnations[1].state === 'exited'
    })
  })

  // --- systemPrompt：v3 worker 契约尾巴 ---

  it('systemPrompt = 现网 agent prompt（goal 模式关闭）+ v3 worker 契约尾巴', () => {
    const { internals } = boot(makeConfig({ systemPrompt: '你是测试人格', skills: [
      { name: 'demo-skill', description: '演示技能', skill_dir: '/tmp/skills/demo' },
    ] }))
    const workspaceRoot = join(tmpRoot, 'ws-prompt')
    const builtin = internals.buildBuiltinWorkerRuntime({ worker_id: 'w-prompt', workspace: { root: workspaceRoot } })!
    const prompt = resolvePrompt(builtin)

    // 复用现网装配：admin 人格 + skill 清单都在。
    expect(prompt).toContain('你是测试人格')
    expect(prompt).toContain('<available_skills>')
    expect(prompt).toContain('demo-skill')
    // 决策 4：goal 模式关闭（GOAL_MODE_DETAILS 段不注入）。
    expect(prompt).not.toContain('## 目标模式详解')

    // v3 worker 契约尾巴接在最后，且交代了协议要求 worker 知道的两件事：
    //   1. 它自己的 workspace 是哪（§5.4：workspace 是跨实现交接的唯一介质）；
    //   2. `finish_task` 是它的终态信号（§5.1：finalize 即 exited）——同时也是本文件
    //      mock LLM 的分流锚点，这里一并钉住。
    // 刻意不断言尾巴的具体措辞（原先断 '## 你的角色：worker' / '没有任何直接联系人类的
    // 工具'，措辞一改就整片挂掉，且断的是文案不是语义）。
    const tailStart = prompt.indexOf(workspaceRoot)
    expect(tailStart, '契约尾巴应点名这个 worker 的 workspace').toBeGreaterThan(-1)
    const tail = prompt.slice(tailStart)
    expect(tail).toContain(WORKER_PROMPT_MARKER)

    // 尾巴不提"你没有联系人类的工具"这类否定式说明：worker 的工具集里本来就没有这些原语
    // （上面"工具集逐项断言"那组用例钉的就是这一点），在 prompt 里点名它们反而把这个念头
    // 塞进上下文。这条断言守的是这个设计决定，不是某句文案。
    for (const forbidden of ['send_message', 'ask_human', 'crab-messaging', '人类']) {
      expect(tail, `契约尾巴不该提 ${forbidden}`).not.toContain(forbidden)
    }
  })

  // --- 缺配置时 fail-loud ---

  it('model_config 缺 powerful slot → 工厂抛错，spawn 如实落成一次失败尝试（不静默降级）', async () => {
    const { internals } = boot(makeConfig({ modelConfig: {} }))
    const dialogObjectId = dialogObjectIdForPrivate('friend-noconf')

    await expect(spawnBuiltin(internals, dialogObjectId)).rejects.toThrow(/powerful/)

    const [w] = await internals.managerStack!.harness.listWorkers(dialogObjectId)
    expect(w.task.status).toBe('failed')
    expect(w.incarnations[0].ended_reason).toBe('failed')
  })
})
