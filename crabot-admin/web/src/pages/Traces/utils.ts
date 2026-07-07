import {
  totalPromptTokens,
  cacheHitRate,
  type AgentSpan,
  type AgentSpanType,
  type TraceIndexEntry,
  type TokenUsage,
} from '../../services/trace'

// ============================================================================
// 常量与格式化
// ============================================================================

export const PAGE_SIZE = 20
export const LIST_REFRESH_MS = 10_000      // 列表轮询：10s
export const DETAIL_REFRESH_MS = 3_000     // 详情轮询（仅 running trace）：3s

export function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return '-'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}m${s}s`
}

export function formatTokens(n?: number): string {
  if (n === undefined || n === null || n === 0) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function formatTime(iso?: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) {
    return d.toLocaleTimeString('zh-CN', { hour12: false })
  }
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function formatDateTimeLocal(iso?: string): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

export function spanTypeLabel(type: AgentSpanType): string {
  const map: Record<AgentSpanType, string> = {
    agent_loop: 'loop',
    llm_call: 'llm',
    tool_call: 'tool',
    sub_agent_call: 'sub-agent',
    decision: 'decision',
    context_assembly: 'ctx',
    context_fetch: 'fetch',
    memory_write: 'mem-w',
    rpc_call: 'rpc',
    bg_entity_exit: 'bg-exit',
    bg_entity_spawn: 'bg-spawn',
    bg_entity_output: 'bg-out',
    bg_entity_kill: 'bg-kill',
    llm_retry: 'retry',
    dispatch_call: 'dispatch',
    dispatch_action: 'dispatch-act',
  }
  return map[type] ?? type
}

export function spanTypeBg(type: AgentSpanType): string {
  const map: Record<AgentSpanType, string> = {
    agent_loop: '#3b82f6',
    llm_call: '#8b5cf6',
    tool_call: '#f59e0b',
    sub_agent_call: '#ec4899',
    decision: '#10b981',
    context_assembly: '#0ea5e9',
    context_fetch: '#06b6d4',
    memory_write: '#14b8a6',
    rpc_call: '#6366f1',
    bg_entity_exit: '#84cc16',
    bg_entity_spawn: '#84cc16',
    bg_entity_output: '#84cc16',
    bg_entity_kill: '#84cc16',
    llm_retry: '#fb923c',
    dispatch_call: '#a855f7',
    dispatch_action: '#c084fc',
  }
  return map[type] ?? '#6b7280'
}

export function statusColor(status: string): string {
  if (status === 'completed') return '#10b981'
  if (status === 'failed') return '#ef4444'
  return '#f59e0b'
}

export const triggerTypeLabel: Record<string, string> = {
  message: 'Dispatch',
  task: 'Task',
  sub_agent_call: 'Sub-agent',
  schedule: 'Schedule',
}

export const triggerTypeColor: Record<string, string> = {
  message: '#3b82f6',
  task: '#8b5cf6',
  sub_agent_call: '#ec4899',
  schedule: '#10b981',
}

// ============================================================================
// FilterState
// ============================================================================

export interface FilterState {
  keyword: string
  status: '' | 'running' | 'completed' | 'failed'
  range: 'all' | 'today' | '24h' | '7d' | 'custom'
  customStart: string
  customEnd: string
  /** 仅看某个任务的所有 trace（fronts / worker / sub-agents） */
  taskId: string
}

export const DEFAULT_FILTER: FilterState = {
  keyword: '',
  status: '',
  range: 'all',
  customStart: '',
  customEnd: '',
  taskId: '',
}

export function rangeToISO(range: FilterState['range'], customStart: string, customEnd: string): { start?: string; end?: string } {
  const now = new Date()
  if (range === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return { start: start.toISOString() }
  }
  if (range === '24h') {
    return { start: new Date(now.getTime() - 24 * 3600_000).toISOString() }
  }
  if (range === '7d') {
    return { start: new Date(now.getTime() - 7 * 24 * 3600_000).toISOString() }
  }
  if (range === 'custom') {
    return {
      ...(customStart ? { start: new Date(customStart).toISOString() } : {}),
      ...(customEnd ? { end: new Date(customEnd).toISOString() } : {}),
    }
  }
  return {}
}

// ============================================================================
// TraceGroup + 分组函数
// ============================================================================

export interface TraceGroup {
  taskId: string | null            // null = 孤儿（无 related_task_id）
  primary: TraceIndexEntry         // 首行用的 trace（fronts[0] > worker > 任意）
  members: TraceIndexEntry[]       // 包含 primary，按时间排
  status: 'running' | 'completed' | 'failed'
  earliestStartedAt: string
  latestEndedAt?: string
  totalDurationMs?: number
  totalSpans: number
  totalUsage?: TokenUsage
}

export function aggregateGroupUsage(members: TraceIndexEntry[]): TokenUsage | undefined {
  let any = false
  let input = 0, output = 0, cacheR = 0, cacheC = 0
  let anyCacheR = false, anyCacheC = false
  for (const m of members) {
    const u = m.total_usage
    if (!u) continue
    any = true
    input += u.input_tokens
    output += u.output_tokens
    if (u.cache_read_tokens !== undefined) { cacheR += u.cache_read_tokens; anyCacheR = true }
    if (u.cache_creation_tokens !== undefined) { cacheC += u.cache_creation_tokens; anyCacheC = true }
  }
  if (!any) return undefined
  return {
    input_tokens: input,
    output_tokens: output,
    ...(anyCacheR ? { cache_read_tokens: cacheR } : {}),
    ...(anyCacheC ? { cache_creation_tokens: cacheC } : {}),
  }
}

export function aggregateGroupStatus(members: TraceIndexEntry[]): TraceGroup['status'] {
  if (members.some((m) => m.status === 'running')) return 'running'
  if (members.some((m) => m.status === 'failed')) return 'failed'
  return 'completed'
}

export function groupEntries(entries: TraceIndexEntry[]): TraceGroup[] {
  const buckets = new Map<string, TraceIndexEntry[]>()
  const orphans: TraceIndexEntry[] = []

  for (const e of entries) {
    if (e.related_task_id) {
      const list = buckets.get(e.related_task_id)
      if (list) list.push(e)
      else buckets.set(e.related_task_id, [e])
    } else {
      orphans.push(e)
    }
  }

  const triggerOrder: Record<string, number> = { message: 0, task: 1, sub_agent_call: 2, schedule: 3 }
  const groups: TraceGroup[] = []

  for (const [taskId, members] of buckets) {
    const sorted = [...members].sort((a, b) => {
      const orderDiff = (triggerOrder[a.trigger_type] ?? 9) - (triggerOrder[b.trigger_type] ?? 9)
      if (orderDiff !== 0) return orderDiff
      return new Date(a.started_at).getTime() - new Date(b.started_at).getTime()
    })
    const fronts = sorted.filter((m) => m.trigger_type === 'message')
    const worker = sorted.find((m) => m.trigger_type === 'task')
    const primary = fronts[0] ?? worker ?? sorted[0]
    const earliest = sorted.reduce((min, m) =>
      new Date(m.started_at).getTime() < new Date(min).getTime() ? m.started_at : min,
      sorted[0].started_at,
    )
    const ends = sorted.map((m) => m.ended_at).filter((x): x is string => Boolean(x))
    const latestEnd = ends.length > 0
      ? ends.reduce((max, x) => new Date(x).getTime() > new Date(max).getTime() ? x : max)
      : undefined
    groups.push({
      taskId,
      primary,
      members: sorted,
      status: aggregateGroupStatus(sorted),
      earliestStartedAt: earliest,
      ...(latestEnd ? { latestEndedAt: latestEnd } : {}),
      ...(latestEnd ? { totalDurationMs: new Date(latestEnd).getTime() - new Date(earliest).getTime() } : {}),
      totalSpans: sorted.reduce((sum, m) => sum + m.span_count, 0),
      ...(aggregateGroupUsage(sorted) ? { totalUsage: aggregateGroupUsage(sorted) } : {}),
    })
  }

  for (const orphan of orphans) {
    groups.push({
      taskId: null,
      primary: orphan,
      members: [orphan],
      status: orphan.status,
      earliestStartedAt: orphan.started_at,
      ...(orphan.ended_at ? { latestEndedAt: orphan.ended_at } : {}),
      ...(orphan.duration_ms !== undefined ? { totalDurationMs: orphan.duration_ms } : {}),
      totalSpans: orphan.span_count,
      ...(orphan.total_usage ? { totalUsage: orphan.total_usage } : {}),
    })
  }

  // 按"组内最新活动时间"倒序
  groups.sort((a, b) => {
    const aT = new Date(a.latestEndedAt ?? a.earliestStartedAt).getTime()
    const bT = new Date(b.latestEndedAt ?? b.earliestStartedAt).getTime()
    return bT - aT
  })

  return groups
}

// ============================================================================
// Trace Epochs
// ============================================================================

export type TraceEpochRole = 'dispatcher' | 'worker' | 'subagent'

export interface TraceEpochMember {
  role: TraceEpochRole
  entry: TraceIndexEntry
}

export interface TraceEpoch {
  id: string
  label: string
  traces: TraceEpochMember[]
  startedAt: string
  endedAt?: string
  durationMs?: number
  status: 'running' | 'completed' | 'failed'
  isLatest: boolean
  isCurrent: boolean
  roleCounts: Record<TraceEpochRole, number>
  totalSpans: number
  totalUsage?: TokenUsage
}

export function buildTraceEpochs({
  fronts,
  workers,
  subagents,
  currentTraceId,
}: {
  fronts: TraceIndexEntry[]
  workers: TraceIndexEntry[]
  subagents: TraceIndexEntry[]
  currentTraceId: string
}): TraceEpoch[] {
  const sortedWorkers = workers
    .slice()
    .sort((a, b) => timeMs(a.started_at) - timeMs(b.started_at))
  const epochStartMode = buildEpochStarts(fronts, sortedWorkers)
  const epochStarts = epochStartMode.starts

  const allMembers: TraceEpochMember[] = [
    ...fronts.map((entry) => ({ role: 'dispatcher' as const, entry })),
    ...sortedWorkers.map((entry) => ({ role: 'worker' as const, entry })),
    ...subagents.map((entry) => ({ role: 'subagent' as const, entry })),
  ].sort((a, b) => timeMs(a.entry.started_at) - timeMs(b.entry.started_at))

  if (epochStarts.length === 0) {
    if (allMembers.length === 0) return []
    return [makeEpoch({
      index: 1,
      members: allMembers,
      isLatest: true,
      currentTraceId,
    })]
  }

  const buckets = epochStarts.map((start, index) => ({
    start,
    index: index + 1,
    startedAt: start.started_at,
    endedAt: epochStartMode.mode === 'action'
      ? epochEndFromNextAction(epochStarts[index + 1])
      : undefined,
    members: [] as TraceEpochMember[],
  }))

  if (epochStartMode.mode === 'action') {
    for (const member of allMembers) {
      if (member.role === 'worker') {
        const memberStart = timeMs(member.entry.started_at)
        const memberEnd = member.entry.ended_at ? timeMs(member.entry.ended_at) : Number.POSITIVE_INFINITY
        for (let i = 0; i < buckets.length; i++) {
          const windowStart = timeMs(buckets[i]!.startedAt)
          const nextStart = epochStarts[i + 1] ? timeMs(epochStarts[i + 1]!.started_at) : Number.POSITIVE_INFINITY
          if (memberStart < nextStart && memberEnd >= windowStart) {
            buckets[i]!.members.push(member)
          }
        }
        continue
      }
      const bucketIndex = epochBucketIndexForTrace(timeMs(member.entry.started_at), epochStarts)
      buckets[bucketIndex]!.members.push(member)
    }
  } else {
    for (const member of allMembers) {
      const started = timeMs(member.entry.started_at)
      const bucketIndex = epochBucketIndexForTrace(started, epochStarts, sortedWorkers)
      buckets[bucketIndex]!.members.push(member)
    }
  }

  const repeatedWorkerTraceIds = new Set<string>()
  const workerMembershipCounts = new Map<string, number>()
  for (const bucket of buckets) {
    for (const member of bucket.members) {
      if (member.role !== 'worker') continue
      workerMembershipCounts.set(member.entry.trace_id, (workerMembershipCounts.get(member.entry.trace_id) ?? 0) + 1)
    }
  }
  for (const [traceId, count] of workerMembershipCounts) {
    if (count > 1) repeatedWorkerTraceIds.add(traceId)
  }

  return buckets
    .filter((bucket) => bucket.members.length > 0)
    .map((bucket, idx, arr) => makeEpoch({
      index: bucket.index,
      members: bucket.members.sort((a, b) => {
        const bucketStarted = timeMs(bucket.startedAt)
        const aTime = Math.max(timeMs(a.entry.started_at), bucketStarted)
        const bTime = Math.max(timeMs(b.entry.started_at), bucketStarted)
        if (aTime !== bTime) return aTime - bTime
        return traceEpochRoleOrder(a.role) - traceEpochRoleOrder(b.role)
      }),
      isLatest: idx === arr.length - 1,
      currentTraceId,
      startedAtOverride: bucket.startedAt,
      endedAtOverride: bucket.endedAt,
      repeatedWorkerTraceIds,
    }))
    .reverse()
}

function makeEpoch({
  index,
  members,
  isLatest,
  currentTraceId,
  startedAtOverride,
  endedAtOverride,
  repeatedWorkerTraceIds,
}: {
  index: number
  members: TraceEpochMember[]
  isLatest: boolean
  currentTraceId: string
  startedAtOverride?: string
  endedAtOverride?: string
  repeatedWorkerTraceIds?: Set<string>
}): TraceEpoch {
  const entries = members.map((m) => m.entry)
  const startedAt = startedAtOverride ?? entries.reduce((min, e) => timeMs(e.started_at) < timeMs(min) ? e.started_at : min, entries[0]!.started_at)
  const endedEntries = entries.filter((e) => e.ended_at)
  const naturalEndedAt = endedEntries.length === entries.length
    ? endedEntries.reduce((max, e) => timeMs(e.ended_at!) > timeMs(max) ? e.ended_at! : max, endedEntries[0]!.ended_at!)
    : undefined
  const endedAt = endedAtOverride ?? naturalEndedAt
  const durationMs = endedAt ? timeMs(endedAt) - timeMs(startedAt) : undefined

  return {
    id: `epoch-${index}`,
    label: `Epoch ${index}`,
    traces: members,
    startedAt,
    ...(endedAt ? { endedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    status: aggregateGroupStatus(entries),
    isLatest,
    isCurrent: members.some((m) =>
      m.entry.trace_id === currentTraceId
      && (m.role !== 'worker' || !repeatedWorkerTraceIds?.has(m.entry.trace_id) || isLatest),
    ),
    roleCounts: {
      dispatcher: members.filter((m) => m.role === 'dispatcher').length,
      worker: members.filter((m) => m.role === 'worker').length,
      subagent: members.filter((m) => m.role === 'subagent').length,
    },
    totalSpans: entries.reduce((sum, e) => sum + e.span_count, 0),
    totalUsage: aggregateGroupUsage(entries),
  }
}

function timeMs(iso: string): number {
  return new Date(iso).getTime()
}

function buildEpochStarts(fronts: TraceIndexEntry[], workers: TraceIndexEntry[]): { mode: 'action' | 'worker'; starts: TraceIndexEntry[] } {
  const actionStarts = fronts
    .filter((entry) => entry.dispatch_actions?.some((action) =>
      action.outcome === 'new_task_spawned' || action.outcome === 'terminal_task_revived',
    ))
    .sort((a, b) => timeMs(a.started_at) - timeMs(b.started_at))

  if (actionStarts.length > 0) return { mode: 'action', starts: actionStarts }
  return { mode: 'worker', starts: workers }
}

function epochEndFromNextAction(next?: TraceIndexEntry): string | undefined {
  return next?.dispatch_actions?.find((action) =>
    action.outcome === 'terminal_task_revived' && action.target_task_completed_at,
  )?.target_task_completed_at
}

function traceEpochRoleOrder(role: TraceEpochRole): number {
  if (role === 'dispatcher') return 0
  if (role === 'worker') return 1
  return 2
}

function epochBucketIndexForTrace(started: number, starts: TraceIndexEntry[], workerFallback?: TraceIndexEntry[]): number {
  if (workerFallback) {
    for (let i = 0; i < workerFallback.length; i++) {
      const current = workerFallback[i]!
      const next = workerFallback[i + 1]
      const currentStart = timeMs(current.started_at)
      const currentEnd = current.ended_at ? timeMs(current.ended_at) : undefined
      if (!next) {
        if (started >= currentStart) return i
        return 0
      }
      const nextStart = timeMs(next.started_at)
      if (started < nextStart) {
        if (currentEnd !== undefined && started > currentEnd) return i + 1
        return i
      }
    }
    return workerFallback.length - 1
  }

  let bucketIndex = 0
  for (let i = 0; i < starts.length; i++) {
    if (timeMs(starts[i]!.started_at) <= started) bucketIndex = i
    else break
  }
  return bucketIndex
}

// ============================================================================
// agentLoopLabel — 把 loop_label 渲染为用户可见 label
// ============================================================================

/**
 * 把 agent_loop span 的 loop_label 渲染为用户可见 label。
 * 兼容旧 trace 字面值：'front' / 'worker' / 'task'；新数据中 loop_label 会是 'task' 或 subagent name。
 */
export function agentLoopLabel(details: { loop_label?: string }): string {
  const label = details.loop_label
  if (!label) return 'Agent Loop'
  if (label === 'front') return 'Dispatch Loop (legacy)'
  if (label === 'worker' || label === 'task') return 'Task Loop'
  return label
}

// ============================================================================
// detailSummary — SpanRow 显示用的一行摘要
// ============================================================================

export function detailSummary(span: AgentSpan): string {
  const d = span.details as Record<string, unknown>
  if (span.type === 'agent_loop') {
    const label = agentLoopLabel({ loop_label: d.loop_label as string | undefined })
    const iters = d.iteration_count ? ` ${d.iteration_count} iters` : ''
    return `${label}${iters}`.trim()
  }
  if (span.type === 'llm_call') {
    const iter = d.iteration ? `iter=${d.iteration}` : ''
    const stop = d.stop_reason ? ` stop:${d.stop_reason}` : ''
    return `${iter}${stop}`
  }
  if (span.type === 'tool_call') return String(d.tool_name ?? '')
  if (span.type === 'sub_agent_call') return `→ ${d.target_module_id ?? ''}`
  if (span.type === 'decision') return String(d.decision_type ?? '')
  if (span.type === 'context_assembly' || span.type === 'context_fetch') {
    const ctx = d.context_type ? ` (${d.context_type})` : ''
    return `Context Assembly${ctx}`
  }
  if (span.type === 'memory_write') return `→ ${d.channel_id ?? ''}`
  if (span.type === 'rpc_call') return `${d.target_module ?? ''}::${d.method ?? ''}`
  if (span.type === 'bg_entity_exit') {
    const id = String(d.entity_id ?? '?')
    const status = String(d.status ?? '?')
    const exitCode = d.exit_code !== undefined ? `, exit=${d.exit_code}` : ''
    const runtimeMs = typeof d.runtime_ms === 'number' ? d.runtime_ms : 0
    return `${id} → ${status}${exitCode}, ran ${formatDuration(runtimeMs)}`
  }
  if (span.type === 'bg_entity_spawn') {
    const id = String(d.entity_id ?? '?')
    const mode = d.mode ? ` (${d.mode})` : ''
    return `${id}${mode}`
  }
  if (span.type === 'bg_entity_output' || span.type === 'bg_entity_kill') {
    return String(d.entity_id ?? '?')
  }
  if (span.type === 'llm_retry') {
    const attempt = d.attempt ?? '?'
    const max = d.max_attempts ?? '?'
    const reason = String(d.error ?? '').slice(0, 80)
    return `attempt ${attempt}/${max}: ${reason}`
  }
  if (span.type === 'dispatch_call') {
    const model = d.model ? String(d.model).split('/').pop() ?? String(d.model) : ''
    const count = d.message_count != null ? ` ${d.message_count} msgs` : ''
    const actions = d.action_count != null ? ` → ${d.action_count} actions` : ''
    return `${model}${count}${actions}`.trim()
  }
  if (span.type === 'dispatch_action') {
    const kind = String(d.kind ?? '')
    const outcome = d.outcome ? ` [${d.outcome}]` : ''
    return `${kind}${outcome}`
  }
  return ''
}

// Re-export service helpers used in sub-components
export { totalPromptTokens, cacheHitRate }

// ============================================================================
// formatBytes
// ============================================================================

/**
 * 把字节数转人类可读字符串（B / KB / MB / GB）。
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${units[i]}`
}
