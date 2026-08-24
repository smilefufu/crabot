import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createAdapter } from '../../engine/llm-adapter.js'
import { forkEngine } from '../../engine/sub-agent.js'
import { recordSubAgentTurn } from '../../engine/sub-agent-trace.js'
import { spawnPersistentAgent } from '../../engine/bg-entities/bg-agent.js'
import type { BgEntityRegistry } from '../../engine/bg-entities/registry.js'
import type { BgAgentRegistryRecord } from '../../engine/bg-entities/types.js'
import { createLspDiagnosticsHook } from '../../hooks/defaults.js'
import { getBgEntitiesLogsDir } from '../../core/data-paths.js'
import type { TraceStore } from '../../core/trace-store.js'
import type { ResolvedPermissions, SubAgentConfig } from '../../types.js'
import type { ToolCallContext, ToolCallResult, ToolDefinition, ToolPermissionConfig } from '../../engine/types.js'
import type { NormalizedTraceEvent, TraceCursor, WorkerSubagentStatus, WorkerSubagentSummary } from '../types.js'
import { filterToolsForSubAgent } from '../../agent/subagent-tool-filter.js'
import { assembleSubAgentPrompt } from '../../agent/subagent-prompt-assembler.js'
import { createBuiltinWorkerHookRegistry } from './runtime.js'

const WORKER_OWNER = '__builtin_worker__'

export interface BuiltinSubagentExecutionContext {
  readonly permissionConfig: ToolPermissionConfig
  readonly resolvedPermissions: ResolvedPermissions
}

function statusOf(status: BgAgentRegistryRecord['status']): WorkerSubagentStatus {
  switch (status) {
    case 'running': return 'running'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'killed': return 'stopped'
    case 'stalled': return 'interrupted'
  }
}

function summaryOf(workerId: string, record: BgAgentRegistryRecord): WorkerSubagentSummary {
  return {
    subagent_id: record.entity_id,
    worker_id: workerId,
    executor_impl: 'builtin',
    ...(record.subagent_type ? { type: record.subagent_type } : {}),
    name: record.subagent_type ?? record.entity_id,
    ...(record.task_description ? { task: record.task_description } : {}),
    status: statusOf(record.status),
    ...(record.spawned_at ? { started_at: record.spawned_at } : {}),
    ...(record.ended_at ? { ended_at: record.ended_at } : {}),
  }
}

/**
 * Small execution boundary for builtin Worker delegate_task. It shares the existing subagent
 * prompt, capability filtering and persistent registry, but does not re-enter AgentHandler's
 * old task loop or its delivery semantics.
 */
export class BuiltinSubagentRunner {
  private readonly abortControllers = new Map<string, AbortController>()
  private registry?: BgEntityRegistry
  private readonly redactText: (text: string) => string

  constructor(
    private readonly traceStore: TraceStore,
    private readonly lspManager: import('../../lsp/lsp-manager.js').LSPManager,
    private readonly deliverCompletion?: (workerId: string, text: string) => Promise<void>,
    registry?: BgEntityRegistry,
    redactText: (text: string) => string = (text) => text,
  ) {
    this.registry = registry
    this.redactText = redactText
  }

  setRegistry(registry: BgEntityRegistry): void {
    this.registry = registry
  }

  /**
   * A builtin child runs in this process, so it cannot survive an Agent restart.
   * Mark only Worker-owned records as interrupted before the Admin read model opens.
   */
  async recoverAfterRestart(): Promise<number> {
    const registry = this.requireRegistry()
    const records = await registry.list({
      owner_friend_id: WORKER_OWNER,
      type: 'agent',
      status: ['running'],
    })
    const endedAt = new Date().toISOString()
    await Promise.all(records.map((record) => registry.update(record.entity_id, {
      status: 'stalled',
      ended_at: endedAt,
    })))
    return records.length
  }

  async run(
    subagent: SubAgentConfig,
    input: { task: string; context?: string; sync?: boolean },
    context: ToolCallContext,
    parentTools: ReadonlyArray<ToolDefinition>,
    execution: BuiltinSubagentExecutionContext,
  ): Promise<ToolCallResult> {
    const registry = this.requireRegistry()
    const worker = context.worker_subagent
    if (!worker?.parent_trace_id) {
      return { isError: true, output: 'builtin worker subagent trace is unavailable for this incarnation' }
    }
    if (input.sync) return this.runSynchronously(subagent, input, context, parentTools, worker, execution)

    const entityId = await spawnPersistentAgent({
      prompt: input.task,
      task_description: input.task,
      subagent_type: subagent.name,
      tools: filterToolsForSubAgent(parentTools, subagent.builtin_capabilities, subagent.allowed_mcp_server_ids, subagent.allowed_skill_ids),
      systemPrompt: assembleSubAgentPrompt(subagent, { parentTaskId: worker.worker_id, callerLabel: 'builtin worker (async)' }),
      model: subagent.model.model_id,
      ...(subagent.model.max_tokens !== undefined ? { maxTokens: subagent.model.max_tokens } : {}),
      adapter: createAdapter({
        endpoint: subagent.model.endpoint,
        apikey: subagent.model.apikey,
        format: subagent.model.format,
        ...(subagent.model.account_id ? { accountId: subagent.model.account_id } : {}),
      }),
      owner: { friend_id: WORKER_OWNER, worker_id: worker.worker_id },
      spawned_by_task_id: worker.worker_id,
      registry,
      abortControllers: this.abortControllers,
      permissionConfig: execution.permissionConfig,
      resolvedPermissions: execution.resolvedPermissions,
      senderIsMaster: false,
      hookRegistry: this.childHookRegistry(subagent),
      ...(subagent.hook_preset === 'lsp_diagnostics' ? { lspManager: this.lspManager } : {}),
      subTrace: {
        traceStore: this.traceStore,
        parentTraceId: worker.parent_trace_id,
        summaryPrefix: `[${subagent.name}]`,
        redactText: this.redactText,
      },
      onExit: async (info) => {
        const current = await registry.get(info.entity_id)
        if (current?.status === 'killed') return
        const outcome = info.status === 'completed' ? '已完成' : '失败'
        const detail = info.finalText || info.error || '无可读结果'
        await this.deliverCompletion?.(worker.worker_id, `<sub_agent_notification>\n${subagent.name} ${outcome}：${detail}\n</sub_agent_notification>`)
      },
    })
    const record = await registry.get(entityId)
    return {
      isError: false,
      output: JSON.stringify({
        agent_id: entityId,
        status: 'launched',
        ...(record?.type === 'agent' && record.trace_id ? { child_trace_id: record.trace_id } : {}),
      }),
    }
  }

  async list(workerId: string): Promise<WorkerSubagentSummary[]> {
    const records = await this.requireRegistry().list({ type: 'agent', spawned_by_task_id: workerId })
    return records
      .filter((record): record is BgAgentRegistryRecord => record.type === 'agent' && record.owner.worker_id === workerId)
      .map((record) => summaryOf(workerId, record))
      .sort((left, right) => (right.started_at ?? '').localeCompare(left.started_at ?? ''))
  }

  async get(workerId: string, subagentId: string): Promise<WorkerSubagentSummary | undefined> {
    const record = await this.requireRegistry().get(subagentId)
    if (record?.type !== 'agent' || record.owner.worker_id !== workerId || record.spawned_by_task_id !== workerId) return undefined
    return summaryOf(workerId, record)
  }

  async readTrace(workerId: string, subagentId: string, cursor?: TraceCursor): Promise<{
    events: NormalizedTraceEvent[]
    nextCursor: TraceCursor
    unavailableReason?: string
  }> {
    const record = await this.requireRegistry().get(subagentId)
    if (record?.type !== 'agent' || record.owner.worker_id !== workerId || record.spawned_by_task_id !== workerId) {
      throw new Error(`worker subagent not found: ${subagentId}`)
    }
    if (!record.trace_id) {
      return { events: [], nextCursor: cursor ?? { offset: 0 }, unavailableReason: 'subagent trace unavailable' }
    }
    const trace = await this.traceStore.getFullTrace(record.trace_id)
    if (!trace) return { events: [], nextCursor: cursor ?? { offset: 0 }, unavailableReason: 'subagent trace expired' }
    const start = cursor?.offset ?? 0
    const events: NormalizedTraceEvent[] = []
    for (let index = start; index < trace.spans.length; index += 1) {
      events.push(...normalizeTraceSpan(trace.spans[index]).map((event) => ({ ...event, source_offset: index })))
    }
    return { events, nextCursor: { offset: trace.spans.length } }
  }

  async stopWorker(workerId: string): Promise<void> {
    const registry = this.requireRegistry()
    const records = await registry.list({ type: 'agent', spawned_by_task_id: workerId })
    await Promise.all(records
      .filter((record): record is BgAgentRegistryRecord => record.type === 'agent' && record.owner.worker_id === workerId && record.status === 'running')
      .map(async (record) => {
        this.abortControllers.get(record.entity_id)?.abort()
        await registry.update(record.entity_id, { status: 'killed', ended_at: new Date().toISOString() })
      }))
  }

  private async runSynchronously(
    subagent: SubAgentConfig,
    input: { task: string; context?: string },
    context: ToolCallContext,
    parentTools: ReadonlyArray<ToolDefinition>,
    worker: NonNullable<ToolCallContext['worker_subagent']>,
    execution: BuiltinSubagentExecutionContext,
  ): Promise<ToolCallResult> {
    const registry = this.requireRegistry()
    const entityId = `agent_${randomBytes(6).toString('hex')}`
    const now = new Date().toISOString()
    const trace = this.traceStore.startTrace({
      module_id: 'sub-agent',
      trigger: { type: 'sub_agent_call', summary: `[${subagent.name}] ${input.task}`.slice(0, 200) },
      parent_trace_id: worker.parent_trace_id!,
    })
    const logsDir = getBgEntitiesLogsDir()
    await fs.mkdir(logsDir, { recursive: true })
    await registry.register({
      entity_id: entityId,
      type: 'agent',
      subagent_type: subagent.name,
      trace_id: trace.trace_id,
      status: 'running',
      task_description: input.task,
      messages_log_file: path.join(logsDir, `${entityId}.jsonl`),
      result_file: null,
      owner: { friend_id: WORKER_OWNER, worker_id: worker.worker_id },
      spawned_by_task_id: worker.worker_id,
      spawned_at: now,
      exit_code: null,
      ended_at: null,
      last_activity_at: now,
    })
    const controller = new AbortController()
    this.abortControllers.set(entityId, controller)
    const abortParent = () => controller.abort()
    context.abortSignal?.addEventListener('abort', abortParent, { once: true })
    try {
      const result = await forkEngine({
        prompt: input.task,
        adapter: createAdapter({
          endpoint: subagent.model.endpoint,
          apikey: subagent.model.apikey,
          format: subagent.model.format,
          ...(subagent.model.account_id ? { accountId: subagent.model.account_id } : {}),
        }),
        model: subagent.model.model_id,
        systemPrompt: assembleSubAgentPrompt(subagent, { parentTaskId: worker.worker_id, callerLabel: 'builtin worker' }),
        tools: filterToolsForSubAgent(parentTools, subagent.builtin_capabilities, subagent.allowed_mcp_server_ids, subagent.allowed_skill_ids),
        maxTurns: subagent.max_turns,
        ...(subagent.model.max_tokens !== undefined ? { maxTokens: subagent.model.max_tokens } : {}),
        ...(input.context ? { parentContext: input.context } : {}),
        abortSignal: controller.signal,
        onTurn: (event) => recordSubAgentTurn(this.traceStore, trace.trace_id, event, this.redactText),
        supportsVision: subagent.model.supports_vision,
        ...(subagent.model.context_window !== undefined ? { contextWindowTokens: subagent.model.context_window } : {}),
        permissionConfig: execution.permissionConfig,
        resolvedPermissions: execution.resolvedPermissions,
        senderIsMaster: false,
        hookRegistry: this.childHookRegistry(subagent),
        lspManager: subagent.hook_preset === 'lsp_diagnostics' ? this.lspManager : undefined,
      })
      const completed = result.outcome === 'completed'
      this.traceStore.endTrace(trace.trace_id, completed ? 'completed' : 'failed', {
        summary: (result.output || result.error || '').slice(0, 200),
        ...(!completed && result.error ? { error: result.error.slice(0, 200) } : {}),
      })
      await registry.update(entityId, {
        status: completed ? 'completed' : 'failed',
        result_file: null,
        exit_code: completed ? 0 : 1,
        ended_at: new Date().toISOString(),
      })
      return {
        isError: !completed,
        output: JSON.stringify({
          agent_id: entityId,
          status: completed ? 'completed' : 'failed',
          output: result.output,
          child_trace_id: trace.trace_id,
        }),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.traceStore.endTrace(trace.trace_id, 'failed', { summary: message.slice(0, 200), error: message.slice(0, 200) })
      await registry.update(entityId, { status: 'failed', error: message, exit_code: 1, ended_at: new Date().toISOString() })
      return { isError: true, output: JSON.stringify({ agent_id: entityId, status: 'failed', child_trace_id: trace.trace_id, error: message }) }
    } finally {
      context.abortSignal?.removeEventListener('abort', abortParent)
      this.abortControllers.delete(entityId)
    }
  }

  private requireRegistry(): BgEntityRegistry {
    if (!this.registry) {
      throw new Error('builtin subagent registry is unavailable before AgentHandler initialization')
    }
    return this.registry
  }

  private childHookRegistry(subagent: SubAgentConfig) {
    const registry = createBuiltinWorkerHookRegistry()
    if (subagent.hook_preset === 'lsp_diagnostics') registry.register(createLspDiagnosticsHook())
    return registry
  }
}

function normalizeTraceSpan(span: import('../../types.js').AgentSpan): NormalizedTraceEvent[] {
  const details = (span.details ?? {}) as Record<string, unknown>
  if (span.type === 'llm_call') {
    const { assistant_text: recordedAssistantText, ...technicalDetails } = details
    const assistantText = typeof recordedAssistantText === 'string'
      ? recordedAssistantText
      : typeof details.output_summary === 'string' ? details.output_summary : undefined
    return [{ ts: span.started_at, kind: 'llm_call', summary: typeof details.stop_reason === 'string' ? `llm ${details.stop_reason}` : 'llm call', detail: technicalDetails }, ...(assistantText ? [{ ts: span.started_at, kind: 'message' as const, role: 'assistant' as const, summary: assistantText.replace(/\s+/g, ' ').trim().slice(0, 200), detail: { content: assistantText } }] : [])]
  }
  if (span.type === 'tool_call') {
    const name = typeof details.tool_name === 'string' ? details.tool_name : 'tool call'
    return [
      { ts: span.started_at, kind: 'tool_call', role: 'assistant', summary: name, detail: details },
      ...(typeof details.output_summary === 'string' ? [{ ts: span.ended_at ?? span.started_at, kind: 'tool_result' as const, role: 'user' as const, summary: details.output_summary, detail: details }] : []),
    ]
  }
  return [{ ts: span.started_at, kind: 'lifecycle', summary: span.type, detail: details }]
}
