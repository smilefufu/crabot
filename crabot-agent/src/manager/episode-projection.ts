/**
 * Manager episode 人话投影（protocol-agent-v3 3.2.0 §8.4）。
 *
 * 独立文件避免 read-model.ts 继续膨胀；纯函数不读盘、不抛畸形 span。
 */
import type { ManagerEpisodeTrace, ManagerEpisodeSpan } from './trace-types.js'

export interface EpisodeAction {
  kind: 'spawn_worker' | 'send_to_worker' | 'cancel_worker' | 'other'
  label: string
  worker_id?: string
}

export interface WorkerProjectionRef {
  worker_id: string
  title?: string
  state_to?: string
}

export interface ManagerEpisodeProjection extends ManagerEpisodeTrace {
  reply_excerpt?: string
  actions?: EpisodeAction[]
  worker_ref?: WorkerProjectionRef
}

export interface EpisodeWorkerFact {
  worker_id: string
  title: string
  status: string
}

const REPLY_TOOLS = new Set(['send_message', 'send_private_message', 'send_master_private'])

export function projectManagerEpisode(
  trace: ManagerEpisodeTrace,
  workerFacts: ReadonlyMap<string, EpisodeWorkerFact>,
): ManagerEpisodeProjection {
  let replyExcerpt: string | undefined
  const actions: EpisodeAction[] = []

  for (const span of trace.spans ?? []) {
    const detail = toolDetail(span)
    if (!detail) continue
    const { name, inputSummary, outputSummary } = detail
    if (!replyExcerpt && REPLY_TOOLS.has(name)) {
      const content = extractStringField(inputSummary, 'content')
      if (content) replyExcerpt = truncate(content, 120)
    }
    if (name === 'spawn_worker') {
      const workerId = extractStringField(outputSummary, 'worker_id')
      const title = extractStringField(inputSummary, 'title')
        ?? (workerId ? workerFacts.get(workerId)?.title : undefined)
      actions.push({
        kind: 'spawn_worker',
        label: `派活：${title ?? workerId ?? '新 worker'}`,
        ...(workerId ? { worker_id: workerId } : {}),
      })
    } else if (name === 'send_to_worker') {
      const workerId = extractStringField(inputSummary, 'worker_id')
      const title = workerId ? workerFacts.get(workerId)?.title : undefined
      actions.push({
        kind: 'send_to_worker',
        label: `跟进：${title ?? workerId ?? 'worker'}`,
        ...(workerId ? { worker_id: workerId } : {}),
      })
    } else if (name === 'kill_worker' || name === 'cancel_worker') {
      const workerId = extractStringField(inputSummary, 'worker_id')
      const title = workerId ? workerFacts.get(workerId)?.title : undefined
      actions.push({
        kind: 'cancel_worker',
        label: `取消：${title ?? workerId ?? 'worker'}`,
        ...(workerId ? { worker_id: workerId } : {}),
      })
    }
  }

  const eventWorkerId = trace.trigger?.type === 'worker_event'
    ? workerIdFromTrigger(trace.trigger.source, trace.trigger.summary)
    : undefined
  const fact = eventWorkerId ? workerFacts.get(eventWorkerId) : undefined
  const workerRef = eventWorkerId ? {
    worker_id: eventWorkerId,
    ...(fact?.title ? { title: fact.title } : {}),
    ...(fact?.status ? { state_to: fact.status } : {}),
  } : undefined

  return {
    ...trace,
    ...(replyExcerpt ? { reply_excerpt: replyExcerpt } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    ...(workerRef ? { worker_ref: workerRef } : {}),
  }
}

export function managerActivitySummary(trace: ManagerEpisodeProjection): string {
  const summary = trace.trigger?.summary ?? ''
  const excerpt = summary.includes('：') ? summary.slice(summary.indexOf('：') + 1).replace(/（合并 \d+ 个唤醒）$/, '') : ''
  switch (trace.trigger?.type) {
    case 'human_message': return excerpt ? `你：${excerpt}` : '收到一条人类消息'
    case 'attention_flush': return excerpt ? `群聊：${excerpt}` : '群聊注意力放行'
    case 'schedule': return summary.replace(/^定时任务:/, '定时：')
    case 'worker_event': return trace.worker_ref?.title
      ? `${trace.worker_ref.title}：${statusLabel(trace.worker_ref.state_to) ?? '有新进展'}`
      : summary
    case 'sub_agent_call': return `子代理：${summary}`
    default: return summary
  }
}

function statusLabel(status: string | undefined): string | undefined {
  if (!status) return undefined
  const labels: Record<string, string> = {
    queued: '排队', running: '执行中', waiting_input: '等输入',
    completed: '已完成', failed: '失败', cancelled: '已取消',
  }
  return labels[status] ?? status
}

function toolDetail(span: ManagerEpisodeSpan): {
  name: string
  inputSummary: string
  outputSummary: string
} | undefined {
  if (span.type !== 'tool_call' || !span.details || typeof span.details !== 'object') return undefined
  const value = span.details as Record<string, unknown>
  if (typeof value.name !== 'string') return undefined
  return {
    name: value.name,
    inputSummary: typeof value.input_summary === 'string' ? value.input_summary : '',
    outputSummary: typeof value.output_summary === 'string' ? value.output_summary : '',
  }
}

/** 截断 JSON summary 也可提取：先 parse，失败后只扫描目标 JSON string token。 */
export function extractStringField(summary: string, field: string): string | undefined {
  if (!summary) return undefined
  try {
    const parsed = JSON.parse(summary) as Record<string, unknown>
    return typeof parsed[field] === 'string' ? parsed[field] : undefined
  } catch {
    // JSON.stringify 字符串 token（处理反斜杠转义，不假定后续 JSON 完整）。
    const marker = `"${field}"`
    const markerAt = summary.indexOf(marker)
    if (markerAt < 0) return undefined
    const colon = summary.indexOf(':', markerAt + marker.length)
    if (colon < 0) return undefined
    const quote = summary.indexOf('"', colon + 1)
    if (quote < 0) return undefined
    let escaped = false
    for (let i = quote + 1; i < summary.length; i += 1) {
      const char = summary[i]
      if (escaped) { escaped = false; continue }
      if (char === '\\') { escaped = true; continue }
      if (char === '"') {
        try { return JSON.parse(summary.slice(quote, i + 1)) as string } catch { return undefined }
      }
    }
    return undefined
  }
}

function workerIdFromTrigger(source: string | undefined, summary: string): string | undefined {
  if (source?.startsWith('worker:')) return source.slice('worker:'.length)
  const match = summary.match(/\((w-[^)]+)\)/)
  return match?.[1]
}

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized
}
