import React, { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Loading } from '../../components/Common/Loading'
import { MainLayout } from '../../components/Layout/MainLayout'
import { agentObservabilityService, type WorkerSubagentSummary } from '../../services/agent-observability'
import { Timeline } from './WorkerDetail'

const IMPL_LABEL: Record<WorkerSubagentSummary['executor_impl'], string> = {
  builtin: '内置 Worker',
  'claude-code': 'Claude Code',
  codex: 'Codex',
}
const STATUS_LABEL: Record<WorkerSubagentSummary['status'], string> = {
  running: '执行中', completed: '已完成', failed: '失败', stopped: '已停止', interrupted: '已中断', unknown: '状态未知',
}

function formatTimestamp(value: string | undefined): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}

export const SubagentDetail: React.FC = () => {
  const { workerId = '', subagentId = '' } = useParams()
  const [subagent, setSubagent] = useState<WorkerSubagentSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    agentObservabilityService.getWorkerSubagentDetail(workerId, subagentId)
      .then((result) => { if (!cancelled) setSubagent(result.subagent) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workerId, subagentId])

  const loadTrace = useCallback((cursor?: string) => agentObservabilityService.getWorkerSubagentTrace(workerId, subagentId, cursor), [workerId, subagentId])

  if (loading) return <MainLayout><Loading /></MainLayout>
  if (error || !subagent) return <MainLayout><div style={{ color: 'var(--text-muted)', padding: 24 }}>子 Agent 详情暂不可用：{error ?? '未找到'}</div></MainLayout>

  return (
    <MainLayout>
      <div style={{ maxWidth: 980 }}>
        <div style={{ marginBottom: 18 }}>
          <Link to={`/traces/workers/${encodeURIComponent(workerId)}`} style={{ color: 'var(--text-muted)', fontSize: 12 }}>← 返回 Worker 详情</Link>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <h1 style={{ fontSize: 22, lineHeight: 1.3, margin: 0 }}>{subagent.name}</h1>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>{subagent.subagent_id}</div>
            </div>
            <span style={{ flex: '0 0 auto', padding: '4px 8px', border: '1px solid var(--border)', fontSize: 12, fontWeight: 700 }}>{STATUS_LABEL[subagent.status]}</span>
          </div>
        </div>

        <section aria-label="子 Agent 概览" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', margin: '22px 0 28px', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
          <div style={{ padding: '12px 14px 13px 0' }}><div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 3 }}>执行器</div><div style={{ fontSize: 13, fontWeight: 600 }}>{IMPL_LABEL[subagent.executor_impl]}</div></div>
          <div style={{ padding: '12px 14px 13px', borderLeft: '1px solid var(--border)' }}><div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 3 }}>子 Agent 类型</div><div style={{ fontSize: 13, fontWeight: 600 }}>{subagent.type ?? '原生记录未提供'}</div></div>
          <div style={{ padding: '12px 14px 13px', borderLeft: '1px solid var(--border)' }}><div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 3 }}>启动时间</div><div style={{ fontSize: 13 }}>{formatTimestamp(subagent.started_at)}</div></div>
          <div style={{ padding: '12px 14px 13px', borderLeft: '1px solid var(--border)' }}><div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 3 }}>结束时间</div><div style={{ fontSize: 13 }}>{formatTimestamp(subagent.ended_at)}</div></div>
        </section>

        {subagent.task && <section style={{ marginBottom: 28 }}><div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 5 }}>任务</div><div style={{ padding: '10px 12px', background: 'var(--bg-muted)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13 }}>{subagent.task}</div></section>}
        {subagent.unavailable_reason && <div style={{ color: 'var(--color-warning, #d97706)', fontSize: 12, marginBottom: 16 }}>部分数据不可用：{subagent.unavailable_reason}</div>}
        <Timeline workerId={workerId} heading="子 Agent Trace" actorLabel="子 Agent" isSubagentTrace loadTrace={loadTrace} />
      </div>
    </MainLayout>
  )
}
