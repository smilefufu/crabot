import { createAdapter } from '../../engine/llm-adapter.js'
import { thinkingParam } from '../../engine/llm-adapter-types.js'
import { spawnPersistentAgent } from '../../engine/bg-entities/bg-agent.js'
import type { BgEntityRegistry } from '../../engine/bg-entities/registry.js'
import type { BgAgentRegistryRecord } from '../../engine/bg-entities/types.js'
import { createLspDiagnosticsHook } from '../../hooks/defaults.js'
import type { TraceStore } from '../../core/trace-store.js'
import type { ResolvedPermissions, SkillConfig, SubAgentConfig } from '../../types.js'
import type { ToolCallContext, ToolCallResult, ToolDefinition, ToolPermissionConfig } from '../../engine/types.js'
import type { NormalizedTraceEvent, TraceCursor, WorkerSubagentStatus, WorkerSubagentSummary } from '../types.js'
import {
  buildCapabilitiesForSubAgent,
  permissionConfigForSubAgent,
} from '../../agent/subagent-tool-filter.js'
import { buildDelegatedTaskPrompt } from '../../agent/delegate-task-tool.js'
import { assembleSubAgentPrompt } from '../../agent/subagent-prompt-assembler.js'
import { createBuiltinWorkerHookRegistry } from './runtime.js'

const WORKER_OWNER = '__builtin_worker__'

export interface BuiltinSubagentExecutionContext {
  readonly permissionConfig: ToolPermissionConfig
  readonly resolvedPermissions: ResolvedPermissions
  readonly availableSkills: ReadonlyArray<SkillConfig>
  readonly getCwd: () => string
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
    input: { task: string; context?: string },
    context: ToolCallContext,
    parentTools: ReadonlyArray<ToolDefinition>,
    execution: BuiltinSubagentExecutionContext,
  ): Promise<ToolCallResult> {
    const registry = this.requireRegistry()
    const worker = context.worker_subagent
    if (!worker?.parent_trace_id) {
      return { isError: true, output: 'builtin worker subagent trace is unavailable for this incarnation' }
    }
    const childCapabilities = this.capabilitiesFor(subagent, parentTools, execution)
    const childExecution = {
      ...execution,
      permissionConfig: permissionConfigForSubAgent(
        execution.permissionConfig,
        childCapabilities.skills,
      ) ?? execution.permissionConfig,
    }
    const childPrompt = assembleSubAgentPrompt(subagent, {
      parentTaskId: worker.worker_id,
      callerLabel: 'builtin worker (async)',
      availableSkills: childCapabilities.skills,
    })

    const entityId = await spawnPersistentAgent({
      prompt: buildDelegatedTaskPrompt(input),
      task_description: input.task,
      subagent_type: subagent.name,
      tools: childCapabilities.tools,
      systemPrompt: childPrompt,
      model: subagent.model.model_id,
      ...(subagent.model.max_tokens !== undefined ? { maxTokens: subagent.model.max_tokens } : {}),
      ...(thinkingParam(subagent.model.thinking_level, subagent.model.thinking_custom) !== undefined
        ? { thinking: thinkingParam(subagent.model.thinking_level, subagent.model.thinking_custom) }
        : {}),
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
      permissionConfig: childExecution.permissionConfig,
      resolvedPermissions: childExecution.resolvedPermissions,
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

  private capabilitiesFor(
    subagent: SubAgentConfig,
    parentTools: ReadonlyArray<ToolDefinition>,
    execution: BuiltinSubagentExecutionContext,
  ) {
    return buildCapabilitiesForSubAgent({
      parentTools,
      capabilities: subagent.builtin_capabilities,
      allowedMcpServerIds: subagent.allowed_mcp_server_ids,
      allowedSkillIds: subagent.allowed_skill_ids,
      availableSkills: execution.availableSkills,
      getCwd: execution.getCwd,
      allowPermissionGatedSkills: execution.resolvedPermissions.tool_access.mcp_skill,
    })
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
    const input = typeof details.input_summary === 'string' ? details.input_summary : undefined
    const output = typeof details.output_summary === 'string' ? details.output_summary : undefined
    const callId = typeof details.call_id === 'string'
      ? details.call_id
      : output !== undefined ? span.span_id : undefined
    const normalizedDetails = {
      ...details,
      ...(callId !== undefined ? { call_id: callId } : {}),
    }
    return [
      {
        ts: span.started_at,
        kind: 'tool_call',
        role: 'assistant',
        summary: name,
        detail: { ...normalizedDetails, name, ...(input !== undefined ? { input } : {}) },
      },
      ...(output !== undefined ? [{
        ts: span.ended_at ?? span.started_at,
        kind: 'tool_result' as const,
        role: 'user' as const,
        summary: output,
        detail: normalizedDetails,
      }] : []),
    ]
  }
  if (span.type === 'tool_result') {
    const output = typeof details.output_summary === 'string'
      ? details.output_summary
      : typeof details.error === 'string' ? details.error : ''
    const subagentId = typeof details.subagent_id === 'string' ? details.subagent_id : undefined
    return [{
      ts: span.started_at,
      kind: 'tool_result',
      role: 'user',
      summary: output,
      detail: { ...details, output },
      ...(subagentId ? { subagent_id: subagentId } : {}),
    }]
  }
  return [{ ts: span.started_at, kind: 'lifecycle', summary: span.type, detail: details }]
}
