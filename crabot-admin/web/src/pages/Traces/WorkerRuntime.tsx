import { useEffect, useState } from 'react'
import type { WorkerRuntimeSnapshot, WorkerTraceEvent } from '../../services/agent-observability'

const PHASES: Record<WorkerRuntimeSnapshot['phase'], string> = {
  preparing: '准备下一次请求', llm_request: '正在请求模型', retry_wait: '重试等待',
  tools: '正在执行工具', compacting: '正在压缩上下文', idle: '等输入', ended: '已结束', unknown: '具体阶段未知',
}

export function runtimeEvent(event: WorkerTraceEvent): { event: string; runtime: WorkerRuntimeSnapshot } | undefined {
  const detail = event.detail as { kind?: string; version?: number; event?: string; runtime?: WorkerRuntimeSnapshot } | undefined
  return detail?.kind === 'worker_runtime' && detail.version === 1 && detail.event && detail.runtime
    ? { event: detail.event, runtime: detail.runtime } : undefined
}

function duration(start: string, end: string | number): string {
  const seconds = Math.max(0, Math.floor(((typeof end === 'number' ? end : Date.parse(end)) - Date.parse(start)) / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

export function runtimeEventText(event: WorkerTraceEvent): string | undefined {
  const detail = runtimeEvent(event)
  if (!detail) return undefined
  const { runtime, event: kind } = detail
  const request = runtime.request
  const label: Record<string, string> = {
    preparing: '准备请求', request_started: '请求已开始', first_response: '已收到响应数据',
    request_completed: '请求已完成', request_failed: '请求失败', retry_wait: runtime.retry?.retry_mode === 'connection_recovery' ? '连接恢复等待' : '重试等待',
    compaction_started: '开始压缩上下文', compaction_finished: runtime.error ? '上下文压缩失败' : '上下文压缩结束',
    input_queued: '输入队列更新', input_injected: '输入已加入上下文', idle: '等输入', ended: '执行已结束', interrupted: '请求已中断',
  }
  return [label[kind] ?? kind,
    request && (kind.startsWith('request_') || kind === 'first_response' || kind === 'retry_wait' || kind === 'interrupted')
      ? `${request.purpose === 'compaction' ? '压缩' : '主推理'} · ${request.model_id} · 第 ${request.attempt} 次尝试${request.ended_at ? ` · ${duration(request.started_at, request.ended_at)}` : ''}` : undefined,
    kind === 'input_queued' && runtime.pending_inputs ? `待注入 ${runtime.pending_inputs.normal + runtime.pending_inputs.priority} 条` : undefined,
    kind === 'retry_wait' && runtime.retry ? `等待 ${runtime.retry.delay_ms / 1000} 秒` : undefined,
    runtime.error,
  ].filter(Boolean).join(' · ')
}

export function WorkerRuntime({ runtime, stale }: { runtime?: WorkerRuntimeSnapshot; stale?: boolean }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (stale || !runtime || ['ended', 'idle', 'unknown'].includes(runtime.phase)) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [runtime?.phase, stale])
  const current = stale ? Date.parse(runtime?.as_of ?? '') : now
  const request = runtime?.request
  const phase = runtime?.phase ?? 'unknown'
  const activeRequest = phase === 'llm_request' || phase === 'retry_wait'
  return <section aria-label="当前执行" style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', padding: '14px 0', marginBottom: 22, fontSize: 13, overflowWrap: 'anywhere' }}>
    <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>当前执行</h2>
    <div style={{ fontWeight: 600 }}>{phase === 'retry_wait' && runtime?.retry?.retry_mode === 'connection_recovery' ? '连接恢复等待' : PHASES[phase]}</div>
    {request && <div style={{ marginTop: 6 }}>{request.purpose === 'compaction' ? '上下文压缩' : '主推理'} · {request.model_id} · 第 {request.attempt} 次尝试
      {activeRequest && phase === 'llm_request' ? ` · ${request.first_response_at ? '已收到响应数据，尚未完成' : '等待响应'}` : ''}
      <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>请求开始于 {new Date(request.started_at).toLocaleString('zh-CN')}
        {request.ended_at ? ` · 持续 ${duration(request.started_at, request.ended_at)}` : phase === 'llm_request' ? ` · 已持续 ${duration(request.started_at, current)}` : ''}</div>
    </div>}
    {phase === 'retry_wait' && runtime?.retry && <div style={{ marginTop: 6 }}>本次计划等待 {runtime.retry.delay_ms / 1000} 秒 · 已等待 {duration(runtime.retry.started_at, current)}{runtime.retry.max_attempts ? ` · 最多 ${runtime.retry.max_attempts} 次尝试` : ''}</div>}
    {runtime?.tools?.map(tool => <div key={tool.call_id} style={{ marginTop: 6 }}>{tool.name} · 已执行 {duration(tool.started_at, current)}</div>)}
    {runtime?.pending_inputs && <div style={{ marginTop: 6 }}>待注入输入 {runtime.pending_inputs.normal + runtime.pending_inputs.priority} 条（优先 {runtime.pending_inputs.priority}，普通 {runtime.pending_inputs.normal}）</div>}
    {(runtime?.error || runtime?.retry?.error) && <div style={{ color: 'var(--error)', marginTop: 6 }}>{runtime.error ?? runtime.retry?.error}</div>}
    {runtime?.unavailable_reason && <div style={{ color: 'var(--warning)', marginTop: 6 }}>观测不完整：{runtime.unavailable_reason}</div>}
    <div style={{ color: 'var(--text-muted)', marginTop: 8, fontSize: 12 }}>最近执行记录：{runtime?.last_observed_at ? new Date(runtime.last_observed_at).toLocaleString('zh-CN') : '暂无阶段证据'}{runtime ? ` · 数据读取于 ${new Date(runtime.as_of).toLocaleTimeString('zh-CN')}` : ''}</div>
  </section>
}
