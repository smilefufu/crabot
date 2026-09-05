import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  createAdapter,
  StreamProcessor,
  type ContentBlock,
  type LLMAdapter,
  type LLMAdapterConfig,
  type LLMFormat,
  type LLMStreamParams,
  type StreamChunk,
  type ToolDefinition,
} from '../../src/engine/index.js'
import { buildManagerStack, type ManagerStack } from '../../src/manager/bootstrap.js'
import type { PrincipalResolverDeps } from '../../src/manager/principal.js'
import { ManagerWorkboardStore, type WorkboardItemDraft } from '../../src/manager/workboard-store.js'
import { createCrabMemoryServer } from '../../src/mcp/crab-memory.js'
import { CLI_DOMAINS, type ChannelMessage, type Friend, type ResolvedPermissions } from '../../src/types.js'
import type { LedgerWorker, ManagerKey } from '../../src/workers/harness/ledger-types.js'
import type { HarnessEvent } from '../../src/workers/harness/worker-events.js'
import type {
  AdapterCapabilities,
  CapabilityBundle,
  DetectResult,
  ForkOptions,
  IncarnationHandle,
  IncarnationRef,
  ResumeOptions,
  SendInputOptions,
  SpawnSpec,
  SupervisionObservation,
  WorkerAdapter,
  WorkerContractState,
  WorkerImplId,
  WorkerTerminalView,
  Workspace,
} from '../../src/workers/types.js'

type JsonRecord = Record<string, unknown>
type ScriptBlock = Extract<ContentBlock, { type: 'text' | 'tool_use' }>

export interface EvaluationAssertion {
  readonly id: string
  readonly passed: boolean
  readonly detail: string
}

export interface ToolCallProjection {
  readonly name: string
  readonly input: JsonRecord
}

export interface RequestProjection {
  readonly request_index: number
  readonly scenario: string
  readonly step: string
  readonly system_prompt: string
  readonly messages: unknown
  readonly tools: Array<{
    readonly name: string
    readonly description: string
    readonly input_schema: unknown
    readonly is_read_only: boolean
  }>
  readonly tool_results: unknown
  response?: {
    readonly text: string
    readonly stop_reason: string | null
    readonly tool_calls: ToolCallProjection[]
    readonly reasoning_blocks: number
  }
  error?: string
}

export interface EvaluationReport {
  readonly schema_version: 1
  readonly mode: 'deterministic' | 'behavior'
  readonly status: 'passed' | 'failed' | 'skipped'
  readonly generated_at: string
  readonly assertions: EvaluationAssertion[]
  readonly requests: RequestProjection[]
  readonly memory_calls: Array<{ readonly method: string; readonly params: unknown }>
  readonly messaging_calls: Array<{ readonly method: string; readonly params: unknown }>
  readonly worker_calls: Array<{ readonly operation: string; readonly worker_id: string; readonly detail?: unknown }>
  readonly skipped_reason?: string
}

interface DeterministicFixture {
  readonly schema_version: 1
  readonly sentinels: {
    readonly workboard: string
    readonly project_doc: string
    readonly task_a: string
    readonly task_b: string
    readonly old_acceptance: string
    readonly new_acceptance: string
  }
}

interface BehaviorCallRule {
  readonly tool: string
  readonly equals?: Record<string, string>
  readonly contains?: Record<string, string>
  readonly contains_any?: Record<string, string[]>
}

interface BehaviorExpectation {
  readonly required_tools?: string[]
  readonly forbidden_tools?: string[]
  readonly required_calls?: BehaviorCallRule[]
  readonly forbidden_calls?: BehaviorCallRule[]
}

interface BehaviorScenario {
  readonly id: string
  readonly title: string
  readonly workitems?: WorkboardItemDraft[]
  readonly workers?: Array<{ readonly worker_id: string; readonly title: string }>
  readonly steps: Array<
    | { readonly kind: 'human'; readonly text: string }
    | { readonly kind: 'worker'; readonly worker_id: string; readonly text: string }
  >
  readonly expect: BehaviorExpectation
}

interface BehaviorFixture {
  readonly schema_version: 1
  readonly runs_per_scenario: number
  readonly scenarios: BehaviorScenario[]
}

interface EvalOptions {
  readonly fixtureDir?: string
  readonly tempRoot?: string
}

interface EnvironmentOptions {
  readonly root: string
  readonly scenario: string
  readonly projectRoot: string
  readonly adapter: RecordingAdapter
  readonly model?: string
}

interface EvaluationEnvironment {
  readonly scenario: string
  readonly managerKey: ManagerKey
  readonly dataRoot: string
  readonly projectRoot: string
  readonly stack: ManagerStack
  readonly recordingAdapter: RecordingAdapter
  readonly workerAdapter: FakeWorkerAdapter
  readonly memoryCalls: Array<{ method: string; params: unknown }>
  readonly messagingCalls: Array<{ method: string; params: unknown }>
  readonly now: () => string
  setStep(step: string): void
  routeHuman(text: string): Promise<void>
  routeWorker(workerId: string, text: string): Promise<void>
  close(): Promise<void>
}

interface WorkerCall {
  readonly operation: string
  readonly worker_id: string
  readonly detail?: unknown
}

interface ScriptResponse {
  readonly blocks: ScriptBlock[]
  readonly stopReason?: 'end_turn' | 'tool_use'
}

type ScriptProducer = (input: {
  readonly requestIndex: number
  readonly scenario: string
  readonly step: string
  readonly params: LLMStreamParams
}) => Promise<ScriptResponse> | ScriptResponse

const FIXED_START_MS = Date.parse('2026-09-04T00:00:00.000Z')
const FRIEND: Friend = {
  id: 'friend-eval',
  display_name: '评测用户',
  permission: 'master',
  channel_identities: [],
  created_at: '2026-09-04T00:00:00.000Z',
  updated_at: '2026-09-04T00:00:00.000Z',
}

function assertFixtureVersion(value: unknown, file: string): asserts value is { schema_version: 1 } {
  if (!value || typeof value !== 'object' || (value as JsonRecord).schema_version !== 1) {
    throw new Error(`${file} 的 schema_version 必须为 1`)
  }
}

async function readJson<T>(file: string): Promise<T> {
  const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf-8'))
  assertFixtureVersion(parsed, file)
  return parsed as T
}

function defaultFixtureDir(): string {
  return process.env.EVAL_FIXTURE_DIR
    ? path.resolve(process.env.EVAL_FIXTURE_DIR)
    : path.resolve(process.cwd(), 'eval/manager-context/fixtures')
}

function makeClock(): () => string {
  let tick = 0
  return () => new Date(FIXED_START_MS + tick++ * 1000).toISOString()
}

function replacementMap(paths: { dataRoot?: string; projectRoot?: string; outputRoot?: string }): Map<string, string> {
  const entries: Array<[string, string]> = []
  if (paths.dataRoot) entries.push([path.resolve(paths.dataRoot), '<data_root>'])
  if (paths.projectRoot) entries.push([path.resolve(paths.projectRoot), '<project_root>'])
  if (paths.outputRoot) entries.push([path.resolve(paths.outputRoot), '<output_root>'])
  entries.sort((left, right) => right[0].length - left[0].length)
  return new Map(entries)
}

function redactString(value: string, replacements: ReadonlyMap<string, string>): string {
  let redacted = value
  for (const [target, replacement] of replacements) redacted = redacted.split(target).join(replacement)
  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
}

function sensitiveKey(key: string): boolean {
  return /^(authorization|apikey|api_key|access_token|refresh_token|id_token|password|secret|credential|credentials)$/i.test(key)
}

export function redactForEvaluation(
  value: unknown,
  replacements: ReadonlyMap<string, string> = new Map(),
): unknown {
  if (typeof value === 'string') return redactString(value, replacements)
  if (Array.isArray(value)) return value.map((entry) => redactForEvaluation(entry, replacements))
  if (!value || typeof value !== 'object') return value

  const record = value as JsonRecord
  if (record.type === 'image') {
    const source = record.source && typeof record.source === 'object'
      ? record.source as JsonRecord
      : undefined
    return {
      type: 'image',
      source: source
        ? { type: source.type, media_type: source.media_type, data: '[REDACTED_IMAGE]' }
        : '[REDACTED_IMAGE]',
    }
  }

  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [
    key,
    sensitiveKey(key) ? '[REDACTED]' : redactForEvaluation(entry, replacements),
  ]))
}

function toolResults(messages: LLMStreamParams['messages']): unknown[] {
  return messages.flatMap((message) => 'toolResults' in message
    ? message.toolResults.map((result) => ({
        tool_use_id: result.tool_use_id,
        content: result.content,
        is_error: result.is_error,
        ...(result.images && result.images.length > 0 ? { images: result.images } : {}),
      }))
    : [])
}

function projectRequest(
  params: LLMStreamParams,
  requestIndex: number,
  scenario: string,
  step: string,
  replacements: ReadonlyMap<string, string>,
): RequestProjection {
  return redactForEvaluation({
    request_index: requestIndex,
    scenario,
    step,
    system_prompt: params.systemPrompt,
    messages: params.messages,
    tools: params.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      is_read_only: tool.isReadOnly,
    })),
    tool_results: toolResults(params.messages),
  }, replacements) as RequestProjection
}

async function* chunksFor(response: ScriptResponse, requestIndex: number): AsyncGenerator<StreamChunk> {
  yield { type: 'message_start', messageId: `eval-message-${requestIndex}` }
  for (const block of response.blocks) {
    if (block.type === 'text') {
      yield { type: 'text_delta', text: block.text }
      continue
    }
    yield { type: 'tool_use_start', id: block.id, name: block.name }
    yield { type: 'tool_use_delta', id: block.id, inputJson: JSON.stringify(block.input) }
    yield { type: 'tool_use_end', id: block.id }
  }
  yield {
    type: 'message_end',
    stopReason: response.stopReason ?? (response.blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    usage: { inputTokens: 10, outputTokens: 5 },
  }
}

class RecordingAdapter implements LLMAdapter {
  readonly records: RequestProjection[] = []
  private step = 'setup'
  private replacements: ReadonlyMap<string, string> = new Map()

  constructor(
    private readonly scenario: string,
    private readonly producer?: ScriptProducer,
    private readonly delegate?: LLMAdapter,
  ) {
    if (!producer && !delegate) throw new Error('RecordingAdapter 需要 scripted producer 或真实 delegate')
  }

  setStep(step: string): void {
    this.step = step
  }

  setReplacements(replacements: ReadonlyMap<string, string>): void {
    this.replacements = replacements
  }

  async *stream(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
    const requestIndex = this.records.length
    const record = projectRequest(params, requestIndex, this.scenario, this.step, this.replacements)
    this.records.push(record)
    const processor = new StreamProcessor()
    try {
      const source = this.producer
        ? chunksFor(await this.producer({ requestIndex, scenario: this.scenario, step: this.step, params }), requestIndex)
        : this.delegate!.stream(params)
      for await (const chunk of source) {
        processor.process(chunk)
        yield chunk
      }
      const response = processor.finalize()
      record.response = redactForEvaluation({
        text: response.text,
        stop_reason: response.stopReason,
        tool_calls: response.toolUseBlocks.map((block) => ({ name: block.name, input: block.input })),
        reasoning_blocks: response.reasoningBlocks.length,
      }, this.replacements) as RequestProjection['response']
    } catch (error) {
      record.error = redactString(error instanceof Error ? error.message : String(error), this.replacements)
      throw error
    }
  }

  updateConfig(config: Partial<LLMAdapterConfig>): void {
    this.delegate?.updateConfig(config)
  }
}

class FakeWorkerAdapter implements WorkerAdapter {
  readonly calls: WorkerCall[] = []
  private readonly states = new Map<string, WorkerContractState>()

  constructor(readonly implId: WorkerImplId, private readonly now: () => string) {}

  setState(workerId: string, state: WorkerContractState): void {
    this.states.set(workerId, state)
  }

  async detect(): Promise<DetectResult> {
    return { installed: true, activated: true, version: 'eval' }
  }

  async provision(ws: Workspace, caps: CapabilityBundle): Promise<void> {
    this.calls.push({ operation: 'provision', worker_id: '', detail: { workspace: ws.root, capabilities: caps } })
  }

  async spawn(spec: SpawnSpec): Promise<IncarnationHandle> {
    this.calls.push({ operation: 'spawn', worker_id: spec.worker_id, detail: { prompt: spec.prompt, workspace: spec.workspace.root } })
    this.states.set(spec.worker_id, 'running')
    return {
      worker_id: spec.worker_id,
      incarnation_id: spec.incarnation_id,
      seq: 1,
      impl: this.implId,
      session_ref: `eval-${this.implId}-${spec.worker_id}-1`,
      initial_input: { control_state: 'running', disposition: 'accepted' },
    }
  }

  async resume(prev: IncarnationRef, wakeInput: string, opts?: ResumeOptions): Promise<IncarnationHandle> {
    const seq = prev.seq + 1
    this.calls.push({ operation: 'resume', worker_id: prev.worker_id, detail: { text: wakeInput } })
    this.states.set(prev.worker_id, 'running')
    return {
      worker_id: prev.worker_id,
      incarnation_id: opts?.incarnation_id,
      seq,
      impl: this.implId,
      session_ref: `eval-${this.implId}-${prev.worker_id}-${seq}`,
      initial_input: { control_state: 'running', disposition: 'accepted' },
    }
  }

  async fork(prev: IncarnationRef, forkInput: string, opts: ForkOptions): Promise<IncarnationHandle> {
    const seq = prev.seq + 1
    this.calls.push({ operation: 'fork', worker_id: prev.worker_id, detail: { question: forkInput, query_id: opts.query_id } })
    return {
      worker_id: prev.worker_id,
      incarnation_id: opts.incarnation_id,
      seq,
      impl: this.implId,
      session_ref: `eval-${this.implId}-${prev.worker_id}-fork-${seq}`,
      query_id: opts.query_id,
      initial_input: { control_state: 'running', disposition: 'accepted' },
    }
  }

  async sendInput(handle: IncarnationHandle, text: string, _opts?: SendInputOptions): Promise<void> {
    this.calls.push({ operation: 'send_input', worker_id: handle.worker_id, detail: { text } })
    this.states.set(handle.worker_id, 'running')
  }

  async readTerminal(handle: IncarnationHandle): Promise<WorkerTerminalView> {
    return { kind: 'headless_text', text: `评测执行器 ${handle.worker_id}`, captured_at: this.now() }
  }

  async state(handle: IncarnationHandle): Promise<WorkerContractState> {
    return this.states.get(handle.worker_id) ?? 'idle'
  }

  async inspectSupervisionActivity(_handle: IncarnationHandle): Promise<SupervisionObservation> {
    return { kind: 'none', next_cursor: { offset: 0 } }
  }

  async kill(handle: IncarnationHandle): Promise<void> {
    this.calls.push({ operation: 'kill', worker_id: handle.worker_id })
    this.states.set(handle.worker_id, 'exited')
  }

  async dispose(): Promise<void> {}

  capabilities(): AdapterCapabilities {
    return { fork: true, revive: true, goalMode: true, subagent: false, structuredTrace: false }
  }
}

function permissions(projectRoot: string): ResolvedPermissions {
  return {
    tool_access: {
      memory: true,
      messaging: true,
      task: true,
      mcp_skill: true,
      file_io: true,
      browser: false,
      shell: false,
      remote_exec: false,
      desktop: false,
    },
    cli_access: Object.fromEntries(CLI_DOMAINS.map((domain) => [domain, 'none'])) as ResolvedPermissions['cli_access'],
    storage: { workspace_path: projectRoot, access: 'readwrite' },
    memory_scopes: ['eval-scope'],
  }
}

function principalResolver(projectRoot: string): PrincipalResolverDeps {
  return {
    resolvePermissions: async () => permissions(projectRoot),
    sessionMemoryScopes: async () => ['eval-scope'],
    sceneProfile: async () => null,
    crabSelfHandle: () => undefined,
    getFriend: async (friendId) => friendId === FRIEND.id ? FRIEND : null,
  }
}

function fakeRpcResult(method: string, sequence: number): unknown {
  switch (method) {
    case 'send_message':
      return { platform_message_id: `eval-outbound-${sequence}`, sent_at: new Date(FIXED_START_MS + sequence * 1000).toISOString() }
    case 'get_history':
      return { messages: [], pagination: { page: 1, page_size: 20, total_items: 0, total_pages: 0 } }
    case 'list_entries':
      return { entries: [], pagination: { page: 1, page_size: 20, total_items: 0, total_pages: 0 } }
    case 'search_memory':
    case 'search_long_term':
      return { results: [] }
    case 'get_scene_profile':
      return { profile: null }
    case 'get_stats':
      return { short_term: 0, long_term: 0 }
    default:
      return { success: true }
  }
}

async function createEnvironment(options: EnvironmentOptions): Promise<EvaluationEnvironment> {
  const dataRoot = path.join(options.root, options.scenario, 'data')
  const managerKey = `eval-channel::${options.scenario}` as ManagerKey
  const now = makeClock()
  const memoryCalls: Array<{ method: string; params: unknown }> = []
  const messagingCalls: Array<{ method: string; params: unknown }> = []
  let step = 'setup'
  let rpcSequence = 0

  const memoryRpc = {
    call: async (_port: number, method: string, params: unknown) => {
      memoryCalls.push({ method, params })
      return fakeRpcResult(method, rpcSequence++)
    },
  }
  const messagingRpc = {
    call: async (_port: number, method: string, params: unknown) => {
      messagingCalls.push({ method, params })
      return fakeRpcResult(method, rpcSequence++)
    },
  }

  const stack = buildManagerStack({
    dataRoot,
    now,
    timezone: () => 'Asia/Shanghai',
    managerAdapter: () => options.adapter,
    managerModel: () => options.model ?? 'manager-context-eval',
    messagingDeps: {
      rpcClient: messagingRpc as never,
      moduleId: 'manager-context-eval',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
    },
    memoryServerFor: (ctx) => createCrabMemoryServer(
      { rpcClient: memoryRpc as never, moduleId: 'manager-context-eval', getMemoryPort: async () => 19100 },
      ctx,
    ),
    callAdmin: async () => ({}) as never,
    principalResolver: principalResolver(options.projectRoot),
    workerImplSnapshot: () => ({
      revision: 1,
      default_impl: 'builtin',
      preference: {},
      statuses: (['builtin', 'claude-code', 'codex'] as const).map((impl) => ({
        impl,
        enabled: impl === 'builtin',
        installed: impl === 'builtin',
        version: impl === 'builtin' ? 'eval' : undefined,
        verification: impl === 'builtin' ? 'passed' : 'never',
        ready: impl === 'builtin',
        capabilities: { fork: true, revive: true, goalMode: true, subagent: false, structuredTrace: false },
      })),
      observed_at: now(),
    }),
    readWorkerActivity: async ({ worker_id, incarnation_id }) => ({
      incarnation_id: incarnation_id ?? `${worker_id}-inc-1`,
      activities: [],
    }),
    capabilityBundle: async () => ({ skills: [], mcp_servers: [] }),
  })

  const originalAdapters = [...stack.adapters.values()]
  const fake = new FakeWorkerAdapter('builtin', now)
  stack.adapters.set('builtin', fake)
  stack.adapters.set('claude-code', new FakeWorkerAdapter('claude-code', now))
  stack.adapters.set('codex', new FakeWorkerAdapter('codex', now))
  await Promise.allSettled(originalAdapters.map((adapter) => adapter.dispose()))

  options.adapter.setReplacements(replacementMap({ dataRoot, projectRoot: options.projectRoot }))

  const routeHuman = async (text: string): Promise<void> => {
    const message: ChannelMessage = {
      platform_message_id: `eval-human-${createHash('sha256').update(`${options.scenario}:${step}:${text}`).digest('hex').slice(0, 12)}`,
      session: { channel_id: 'eval-channel', session_id: options.scenario, type: 'private' },
      sender: { platform_user_id: 'eval-user', platform_display_name: '评测用户' },
      content: { type: 'text', text },
      features: { is_mention_crab: false },
      platform_timestamp: now(),
    }
    const result = await stack.registry.routeHumanMessages('eval-channel', options.scenario, [message], FRIEND)
    if (result.outcome !== 'completed' && result.outcome !== 'max_turns') {
      throw new Error(`Manager 人类消息 episode 失败: ${result.outcome}`)
    }
  }

  const routeWorker = async (workerId: string, text: string): Promise<void> => {
    const event: HarnessEvent = {
      ts: now(),
      kind: 'state_changed',
      worker_id: workerId,
      seq: 1,
      detail: { to: 'idle', text },
    }
    const result = await stack.registry.routeWorkerEvent(event)
    if (result && result.outcome !== 'completed' && result.outcome !== 'max_turns') {
      throw new Error(`Manager Worker 事件 episode 失败: ${result.outcome}`)
    }
  }

  return {
    scenario: options.scenario,
    managerKey,
    dataRoot,
    projectRoot: options.projectRoot,
    stack,
    recordingAdapter: options.adapter,
    workerAdapter: fake,
    memoryCalls,
    messagingCalls,
    now,
    setStep(value: string) {
      step = value
      options.adapter.setStep(value)
    },
    routeHuman,
    routeWorker,
    close: () => stack.dispose(),
  }
}

function workboardStore(env: EvaluationEnvironment): ManagerWorkboardStore {
  return new ManagerWorkboardStore(path.join(env.dataRoot, 'agent', 'managers'), env.now)
}

async function seedWorkitems(env: EvaluationEnvironment, items: readonly WorkboardItemDraft[]): Promise<void> {
  const store = workboardStore(env)
  for (const item of items) await store.create(env.managerKey, item)
}

async function seedWorker(env: EvaluationEnvironment, workerId: string, title: string): Promise<void> {
  const createdAt = env.now()
  const worker: LedgerWorker = {
    worker_id: workerId,
    manager_key: env.managerKey,
    task: { id: workerId, title, status: 'running', created_at: createdAt },
    origin: { trigger_type: 'message', creator_friend_id: FRIEND.id },
    report_to: { channel_id: 'eval-channel', session_id: env.scenario },
    incarnations: [{
      incarnation_id: `${workerId}-inc-1`,
      seq: 1,
      impl: 'builtin',
      state: 'idle',
      workspace: env.projectRoot,
      session_ref: `${workerId}-session`,
      started_at: createdAt,
    }],
    updated_at: createdAt,
  }
  await env.stack.ledger.upsertWorker(env.managerKey, workerId, () => worker)
  env.workerAdapter.setState(workerId, 'idle')
}

function toolCall(id: string, name: string, input: JsonRecord): ScriptBlock {
  return { type: 'tool_use', id, name, input }
}

function textResponse(text = '评测步骤已处理'): ScriptResponse {
  return { blocks: [{ type: 'text', text }], stopReason: 'end_turn' }
}

function requestContains(record: RequestProjection, marker: string): boolean {
  return JSON.stringify({ system_prompt: record.system_prompt, messages: record.messages, tools: record.tools }).includes(marker)
}

function responseCalls(records: readonly RequestProjection[]): Array<ToolCallProjection & { scenario: string; step: string }> {
  return records.flatMap((record) => (record.response?.tool_calls ?? []).map((call) => ({
    ...call,
    scenario: record.scenario,
    step: record.step,
  })))
}

function assertion(id: string, passed: boolean, detail: string): EvaluationAssertion {
  return { id, passed, detail }
}

async function copyProjectFixture(fixtureDir: string, runRoot: string): Promise<string> {
  const projectRoot = path.join(runRoot, 'project')
  await fs.mkdir(runRoot, { recursive: true })
  await fs.cp(path.join(fixtureDir, 'project'), projectRoot, { recursive: true, dereference: false })
  return projectRoot
}

async function deterministicWorkboardScenario(
  runRoot: string,
  projectRoot: string,
  markers: DeterministicFixture['sentinels'],
): Promise<{ env: EvaluationEnvironment; assertions: EvaluationAssertion[] }> {
  const adapter = new RecordingAdapter('deterministic-workboard', async ({ requestIndex }) => {
    if (requestIndex === 0) {
      return { blocks: [toolCall('wb-inspect', 'inspect_workboard', { view: 'active' })] }
    }
    return textResponse('已根据任务板核对当前任务。')
  })
  const env = await createEnvironment({ root: runRoot, scenario: 'deterministic-workboard', projectRoot, adapter })
  await seedWorkitems(env, [{
    title: '核查棉花糖上下文',
    status: 'in_progress',
    project_root: projectRoot,
    objective: markers.workboard,
    acceptance: ['逐次核对请求'],
    current_state: '等待主控主动查询',
    next_action: '读取当前任务板',
    blockers: [],
  }])
  env.setStep('inspect-workboard')
  await env.routeHuman('请核对当前未结事项，再告诉我下一步。')
  const [before, after] = adapter.records
  return {
    env,
    assertions: [
      assertion('workboard-not-injected-before-inspect', !!before && !requestContains(before, markers.workboard), '首次请求不得包含任务板哨兵'),
      assertion('workboard-visible-after-inspect', !!after && requestContains(after, markers.workboard), 'inspect_workboard 工具结果必须出现在后续请求'),
      assertion('workboard-never-in-system-prompt', adapter.records.every((record) => !record.system_prompt.includes(markers.workboard)), '动态任务板不得进入系统提示词'),
    ],
  }
}

async function deterministicProjectDocScenario(
  runRoot: string,
  projectRoot: string,
  markers: DeterministicFixture['sentinels'],
): Promise<{ env: EvaluationEnvironment; assertions: EvaluationAssertion[] }> {
  const adapter = new RecordingAdapter('deterministic-project-doc', async ({ requestIndex }) => {
    if (requestIndex === 0) {
      return {
        blocks: [toolCall('doc-read', 'inspect_project_docs', {
          project_root: projectRoot,
          operation: 'read',
          path: 'README.md',
        })],
      }
    }
    return textResponse('已读取项目事实。')
  })
  const env = await createEnvironment({ root: runRoot, scenario: 'deterministic-project-doc', projectRoot, adapter })
  env.setStep('inspect-project-doc')
  await env.routeHuman('请查阅项目 README 后确认项目事实。')
  const [before, after] = adapter.records
  return {
    env,
    assertions: [
      assertion('project-doc-not-injected-before-read', !!before && !requestContains(before, markers.project_doc), '读取前请求不得包含项目文档正文'),
      assertion('project-doc-visible-after-read', !!after && requestContains(after, markers.project_doc), '读取结果必须只在后续请求出现'),
      assertion('project-doc-never-in-system-prompt', adapter.records.every((record) => !record.system_prompt.includes(markers.project_doc)), '项目文档正文不得进入系统提示词'),
    ],
  }
}

async function deterministicInterleavingScenario(
  runRoot: string,
  projectRoot: string,
  markers: DeterministicFixture['sentinels'],
): Promise<{ env: EvaluationEnvironment; assertions: EvaluationAssertion[] }> {
  const turns = new Map<string, number>()
  const itemA: WorkboardItemDraft = {
    title: '核查上下文请求',
    status: 'in_progress',
    objective: markers.task_a,
    acceptance: ['还原全部请求'],
    current_state: '等待事件 A',
    next_action: '处理事件 A',
    blockers: [],
  }
  const itemB: WorkboardItemDraft = {
    title: '构建隔离评测',
    status: 'in_progress',
    objective: markers.task_b,
    acceptance: ['Docker 无网络运行'],
    current_state: '等待事件 B',
    next_action: '处理事件 B',
    blockers: [],
  }
  const adapter = new RecordingAdapter('deterministic-interleaving', ({ step }) => {
    const turn = turns.get(step) ?? 0
    turns.set(step, turn + 1)
    if (turn > 0) return textResponse()
    if (step === 'worker-a') {
      return { blocks: [
        toolCall('revise-a', 'change_workboard', {
          action: 'revise',
          current_title: itemA.title,
          item: { ...itemA, current_state: `${markers.task_a} 已收到新证据`, next_action: '继续逐次核对' },
        }),
        toolCall('send-a', 'send_to_worker', { worker_id: 'worker-a', text: `继续 ${markers.task_a}，只处理请求核查。` }),
      ] }
    }
    if (step === 'worker-b') {
      return { blocks: [
        toolCall('revise-b', 'change_workboard', {
          action: 'revise',
          current_title: itemB.title,
          item: { ...itemB, current_state: `${markers.task_b} 已完成镜像准备`, next_action: '运行无网络评测' },
        }),
        toolCall('send-b', 'send_to_worker', { worker_id: 'worker-b', text: `继续 ${markers.task_b}，只处理 Docker 评测。` }),
      ] }
    }
    return textResponse()
  })
  const env = await createEnvironment({ root: runRoot, scenario: 'deterministic-interleaving', projectRoot, adapter })
  await seedWorkitems(env, [itemA, itemB])
  await seedWorker(env, 'worker-a', '核查上下文请求：逐次还原请求')
  await seedWorker(env, 'worker-b', '构建隔离评测：验证 Docker 场景')
  env.setStep('worker-a')
  await env.routeWorker('worker-a', '请求核查发现新证据。')
  env.setStep('worker-b')
  await env.routeWorker('worker-b', 'Docker 镜像准备完成。')

  const board = await workboardStore(env).load(env.managerKey)
  const sent = env.workerAdapter.calls.filter((call) => call.operation === 'send_input')
  const sentA = sent.find((call) => call.worker_id === 'worker-a')
  const sentB = sent.find((call) => call.worker_id === 'worker-b')
  const detailA = JSON.stringify(sentA?.detail ?? {})
  const detailB = JSON.stringify(sentB?.detail ?? {})
  return {
    env,
    assertions: [
      assertion('interleaved-worker-a-target', detailA.includes(markers.task_a) && !detailA.includes(markers.task_b), 'A 事件只能续办 A 执行器和 A 内容'),
      assertion('interleaved-worker-b-target', detailB.includes(markers.task_b) && !detailB.includes(markers.task_a), 'B 事件只能续办 B 执行器和 B 内容'),
      assertion(
        'interleaved-workboard-items-isolated',
        board.active.some((item) => item.title === itemA.title && item.current_state.includes(markers.task_a) && !item.current_state.includes(markers.task_b)) &&
          board.active.some((item) => item.title === itemB.title && item.current_state.includes(markers.task_b) && !item.current_state.includes(markers.task_a)),
        '交错事件后的两个任务项必须各自保留对应状态',
      ),
    ],
  }
}

async function deterministicRevisionScenario(
  runRoot: string,
  projectRoot: string,
  markers: DeterministicFixture['sentinels'],
): Promise<{ env: EvaluationEnvironment; assertions: EvaluationAssertion[] }> {
  const turns = new Map<string, number>()
  const oldItem: WorkboardItemDraft = {
    title: '迁移方案核查',
    status: 'in_progress',
    objective: '输出简要结论',
    acceptance: [markers.old_acceptance],
    current_state: '按旧目标执行中',
    next_action: '等待结果',
    blockers: [],
  }
  const newItem: WorkboardItemDraft = {
    title: oldItem.title,
    status: 'in_progress',
    objective: '逐次核对所有请求',
    acceptance: [markers.new_acceptance],
    current_state: '目标与验收已经更新',
    next_action: '按新验收继续核查',
    blockers: [],
  }
  const adapter = new RecordingAdapter('deterministic-revision', ({ step }) => {
    const turn = turns.get(step) ?? 0
    turns.set(step, turn + 1)
    if (turn > 0) return textResponse()
    if (step === 'human-revision') {
      return { blocks: [
        toolCall('revise-current', 'change_workboard', { action: 'revise', current_title: oldItem.title, item: newItem }),
        toolCall('continue-current', 'send_to_worker', {
          worker_id: 'worker-revision',
          text: `当前完整要求：目标是逐次核对所有请求；验收为 ${markers.new_acceptance}。旧要求失效。`,
        }),
      ] }
    }
    if (step === 'old-result') {
      return { blocks: [toolCall('reject-old-result', 'send_to_worker', {
        worker_id: 'worker-revision',
        text: `你提交的是失效目标，请继续按当前完整验收 ${markers.new_acceptance} 执行。`,
      })] }
    }
    return textResponse()
  })
  const env = await createEnvironment({ root: runRoot, scenario: 'deterministic-revision', projectRoot, adapter })
  await seedWorkitems(env, [oldItem])
  await seedWorker(env, 'worker-revision', '迁移方案核查：验证当前验收')
  env.setStep('human-revision')
  await env.routeHuman('目标调整为逐次核对所有请求，验收也以新的完整要求为准。')
  env.setStep('old-result')
  await env.routeWorker('worker-revision', `已经按 ${markers.old_acceptance} 做完。`)

  const board = await workboardStore(env).load(env.managerKey)
  const calls = responseCalls(adapter.records)
  const sentTexts = env.workerAdapter.calls
    .filter((call) => call.operation === 'send_input')
    .map((call) => JSON.stringify(call.detail ?? {}))
  return {
    env,
    assertions: [
      assertion(
        'revision-replaces-old-acceptance',
        board.active.length === 1 && board.active[0].acceptance.join('\n').includes(markers.new_acceptance) &&
          !board.active[0].acceptance.join('\n').includes(markers.old_acceptance),
        'revise 必须完整替换旧验收',
      ),
      assertion('revision-does-not-archive-old-result', board.archive.length === 0 && !calls.some((call) => call.name === 'change_workboard' && call.input.action === 'archive'), '旧验收结果不得触发完成归档'),
      assertion('revision-worker-receives-current-requirements', sentTexts.length === 2 && sentTexts.every((text) => text.includes(markers.new_acceptance)), '相关执行器每次续办都应收到完整的新验收'),
    ],
  }
}

function projectWorkerCalls(environments: readonly EvaluationEnvironment[], replacements: ReadonlyMap<string, string>): EvaluationReport['worker_calls'] {
  return environments.flatMap((env) => env.workerAdapter.calls.map((call) => redactForEvaluation(call, replacements) as EvaluationReport['worker_calls'][number]))
}

export async function runDeterministicEvaluation(options: EvalOptions = {}): Promise<EvaluationReport> {
  const fixtureDir = options.fixtureDir ? path.resolve(options.fixtureDir) : defaultFixtureDir()
  const ownedRoot = options.tempRoot === undefined
  const runRoot = options.tempRoot ? path.resolve(options.tempRoot) : await fs.mkdtemp(path.join(tmpdir(), 'crabot-manager-context-eval-'))
  const fixture = await readJson<DeterministicFixture>(path.join(fixtureDir, 'deterministic.json'))
  const projectRoot = await copyProjectFixture(fixtureDir, runRoot)
  const environments: EvaluationEnvironment[] = []
  const assertions: EvaluationAssertion[] = []

  try {
    for (const run of [
      deterministicWorkboardScenario,
      deterministicProjectDocScenario,
      deterministicInterleavingScenario,
      deterministicRevisionScenario,
    ]) {
      const result = await run(runRoot, projectRoot, fixture.sentinels)
      environments.push(result.env)
      assertions.push(...result.assertions)
    }

    const memoryCalls = environments.flatMap((env) => env.memoryCalls)
    assertions.push(assertion(
      'memory-has-no-workboard-or-project-doc-mirror',
      memoryCalls.length === 0,
      '任务板和项目文档操作不得自动调用 crab-memory',
    ))

    const replacements = replacementMap({ dataRoot: runRoot, projectRoot })
    const requests = environments.flatMap((env) => env.recordingAdapter.records)
    return {
      schema_version: 1,
      mode: 'deterministic',
      status: assertions.every((entry) => entry.passed) ? 'passed' : 'failed',
      generated_at: new Date().toISOString(),
      assertions,
      requests,
      memory_calls: redactForEvaluation(memoryCalls, replacements) as EvaluationReport['memory_calls'],
      messaging_calls: redactForEvaluation(environments.flatMap((env) => env.messagingCalls), replacements) as EvaluationReport['messaging_calls'],
      worker_calls: projectWorkerCalls(environments, replacements),
    }
  } finally {
    await Promise.allSettled(environments.map((env) => env.close()))
    if (ownedRoot) await fs.rm(runRoot, { recursive: true, force: true })
  }
}

function matchesRule(call: ToolCallProjection, rule: BehaviorCallRule): boolean {
  if (call.name !== rule.tool) return false
  if (rule.equals && !Object.entries(rule.equals).every(([key, value]) => call.input[key] === value)) return false
  if (rule.contains && !Object.entries(rule.contains).every(([key, value]) => typeof call.input[key] === 'string' && (call.input[key] as string).includes(value))) return false
  if (rule.contains_any && !Object.entries(rule.contains_any).every(([key, values]) => typeof call.input[key] === 'string' && values.some((value) => (call.input[key] as string).includes(value)))) return false
  return true
}

const READ_ONLY_MEMORY_METHODS = new Set([
  'search_short_term',
  'search_long_term',
  'get_memory',
  'list_recent',
  'list_entries',
  'get_stats',
  'get_evolution_mode',
  'get_scene_profile',
])

export function selectMemoryWriteCalls(
  calls: ReadonlyArray<{ readonly method: string; readonly params: unknown }>,
): Array<{ readonly method: string; readonly params: unknown }> {
  return calls.filter((call) => !READ_ONLY_MEMORY_METHODS.has(call.method))
}

function gradeBehaviorScenario(
  scenario: BehaviorScenario,
  run: number,
  env: EvaluationEnvironment,
): EvaluationAssertion[] {
  const calls = responseCalls(env.recordingAdapter.records)
  const names = new Set(calls.map((call) => call.name))
  const prefix = `${scenario.id}-run-${run}`
  const results: EvaluationAssertion[] = []
  for (const tool of scenario.expect.required_tools ?? []) {
    results.push(assertion(`${prefix}-requires-${tool}`, names.has(tool), `${scenario.title} 必须调用 ${tool}`))
  }
  for (const tool of scenario.expect.forbidden_tools ?? []) {
    results.push(assertion(`${prefix}-forbids-${tool}`, !names.has(tool), `${scenario.title} 不得调用 ${tool}`))
  }
  for (const [index, rule] of (scenario.expect.required_calls ?? []).entries()) {
    results.push(assertion(`${prefix}-required-call-${index}`, calls.some((call) => matchesRule(call, rule)), `${scenario.title} 缺少符合约束的 ${rule.tool} 调用`))
  }
  for (const [index, rule] of (scenario.expect.forbidden_calls ?? []).entries()) {
    results.push(assertion(`${prefix}-forbidden-call-${index}`, !calls.some((call) => matchesRule(call, rule)), `${scenario.title} 出现禁止的 ${rule.tool} 调用`))
  }

  const memoryPayload = JSON.stringify(selectMemoryWriteCalls(env.memoryCalls))
  const markers = [
    ...(scenario.workitems ?? []).flatMap((item) => [item.title, item.objective, ...item.acceptance]),
    'PROJECT_DOC_SENTINEL_SHARED_FACT',
  ]
  results.push(assertion(
    `${prefix}-no-memory-mirror`,
    markers.every((marker) => !memoryPayload.includes(marker)),
    `${scenario.title} 不得把任务板或项目文档正文镜像进 Memory`,
  ))
  return results
}

async function behaviorScenarios(fixtureDir: string): Promise<{ runs: number; scenarios: BehaviorScenario[] }> {
  const fixture = await readJson<BehaviorFixture>(path.join(fixtureDir, 'behavior-scenarios.json'))
  const timeline = await readJson<BehaviorScenario & { schema_version: 1 }>(path.join(fixtureDir, 'marshmallow-timeline.json'))
  return { runs: fixture.runs_per_scenario, scenarios: [...fixture.scenarios, timeline] }
}

function behaviorConfigFromEnv(): { format: LLMFormat; endpoint: string; apikey: string; model: string; accountId?: string } | { missing: string[] } {
  const required = ['EVAL_FORMAT', 'EVAL_ENDPOINT', 'EVAL_API_KEY', 'EVAL_MODEL'] as const
  const missing = required.filter((name) => !process.env[name]?.trim())
  if (missing.length > 0) return { missing: [...missing] }
  const format = process.env.EVAL_FORMAT
  if (format !== 'anthropic' && format !== 'openai' && format !== 'gemini' && format !== 'openai-responses') {
    throw new Error('EVAL_FORMAT 必须是 anthropic、openai、gemini 或 openai-responses')
  }
  return {
    format,
    endpoint: process.env.EVAL_ENDPOINT!,
    apikey: process.env.EVAL_API_KEY!,
    model: process.env.EVAL_MODEL!,
    ...(process.env.EVAL_ACCOUNT_ID ? { accountId: process.env.EVAL_ACCOUNT_ID } : {}),
  }
}

export async function runBehaviorEvaluation(options: EvalOptions = {}): Promise<EvaluationReport> {
  const config = behaviorConfigFromEnv()
  if ('missing' in config) {
    return {
      schema_version: 1,
      mode: 'behavior',
      status: 'skipped',
      generated_at: new Date().toISOString(),
      assertions: [],
      requests: [],
      memory_calls: [],
      messaging_calls: [],
      worker_calls: [],
      skipped_reason: `缺少专用评测配置: ${config.missing.join(', ')}`,
    }
  }

  const fixtureDir = options.fixtureDir ? path.resolve(options.fixtureDir) : defaultFixtureDir()
  const ownedRoot = options.tempRoot === undefined
  const runRoot = options.tempRoot ? path.resolve(options.tempRoot) : await fs.mkdtemp(path.join(tmpdir(), 'crabot-manager-context-behavior-'))
  const loaded = await behaviorScenarios(fixtureDir)
  const environments: EvaluationEnvironment[] = []
  const assertions: EvaluationAssertion[] = []

  try {
    for (const scenario of loaded.scenarios) {
      for (let run = 1; run <= loaded.runs; run += 1) {
        const scenarioId = `${scenario.id}-${run}`
        const projectRoot = await copyProjectFixture(fixtureDir, path.join(runRoot, scenarioId))
        const delegate = createAdapter({
          endpoint: config.endpoint,
          apikey: config.apikey,
          format: config.format,
          ...(config.accountId ? { accountId: config.accountId } : {}),
        })
        const adapter = new RecordingAdapter(scenarioId, undefined, delegate)
        const env = await createEnvironment({ root: runRoot, scenario: scenarioId, projectRoot, adapter, model: config.model })
        environments.push(env)
        await seedWorkitems(env, scenario.workitems ?? [])
        for (const worker of scenario.workers ?? []) await seedWorker(env, worker.worker_id, worker.title)

        try {
          for (const [index, step] of scenario.steps.entries()) {
            env.setStep(`step-${index + 1}-${step.kind}`)
            if (step.kind === 'human') {
              await env.routeHuman(step.text.split('{{project_root}}').join(projectRoot))
            } else {
              await env.routeWorker(step.worker_id, step.text)
            }
          }
          assertions.push(...gradeBehaviorScenario(scenario, run, env))
        } catch (error) {
          assertions.push(assertion(
            `${scenario.id}-run-${run}-infrastructure`,
            false,
            error instanceof Error ? error.message : String(error),
          ))
        }
      }
    }

    const replacements = replacementMap({ dataRoot: runRoot })
    return {
      schema_version: 1,
      mode: 'behavior',
      status: assertions.every((entry) => entry.passed) ? 'passed' : 'failed',
      generated_at: new Date().toISOString(),
      assertions,
      requests: environments.flatMap((env) => env.recordingAdapter.records),
      memory_calls: redactForEvaluation(environments.flatMap((env) => env.memoryCalls), replacements) as EvaluationReport['memory_calls'],
      messaging_calls: redactForEvaluation(environments.flatMap((env) => env.messagingCalls), replacements) as EvaluationReport['messaging_calls'],
      worker_calls: projectWorkerCalls(environments, replacements),
    }
  } finally {
    await Promise.allSettled(environments.map((env) => env.close()))
    if (ownedRoot) await fs.rm(runRoot, { recursive: true, force: true })
  }
}

export async function writeEvaluationReport(report: EvaluationReport, outputDir: string): Promise<string> {
  const targetDir = path.resolve(outputDir)
  await fs.mkdir(targetDir, { recursive: true })
  const target = path.join(targetDir, 'report.json')
  await fs.writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx' })
  return target
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? process.env.EVAL_MODE ?? 'deterministic'
  if (mode !== 'deterministic' && mode !== 'behavior') throw new Error('评测模式必须是 deterministic 或 behavior')
  const report = mode === 'deterministic'
    ? await runDeterministicEvaluation()
    : await runBehaviorEvaluation()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outputDir = process.env.EVAL_OUTPUT_DIR
    ? path.resolve(process.env.EVAL_OUTPUT_DIR)
    : path.resolve(process.cwd(), 'eval/manager-context/out', `${stamp}-${process.pid}`)
  const file = await writeEvaluationReport(report, outputDir)
  process.stdout.write(`${JSON.stringify({ mode: report.mode, status: report.status, report: file, skipped_reason: report.skipped_reason })}\n`)
  if (report.status === 'failed') process.exitCode = 1
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
