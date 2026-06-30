import React, { useState, useEffect, useCallback } from 'react'
import {
  bgEntitiesService,
  bgStatusColor,
  bgStatusLabel,
  bgFormatRuntime,
  type BgEntity,
} from '../../services/bg-entities'
import { Button } from '../../components/Common/Button'
import { ConfirmModal } from '../../components/Common/ConfirmModal'
import { LogModal } from './LogModal'

/** 终态附加：exit code（completed/failed 有意义）。 */
function exitSuffix(e: BgEntity): string {
  if (e.status === 'running') return ''
  return e.exit_code !== null && e.exit_code !== undefined ? ` · exit ${e.exit_code}` : ''
}

const POLL_INTERVAL_MS = 5000

// ---------------------------------------------------------------------------
// TaskBgShells — trace 详情里内嵌「该 task 的后台 shell」（running 优先 + kill + 日志）。
// 只显示 type==='shell'；subagent 交给 RelatedTraceTree。无 shell 时不渲染。
// ---------------------------------------------------------------------------

export const TaskBgShells: React.FC<{ taskId: string }> = ({ taskId }) => {
  const [shells, setShells] = useState<BgEntity[]>([])
  const [loaded, setLoaded] = useState(false)
  const [showTerminal, setShowTerminal] = useState(false)
  const [killTarget, setKillTarget] = useState<BgEntity | null>(null)
  const [killing, setKilling] = useState(false)
  const [logEntity, setLogEntity] = useState<BgEntity | null>(null)

  const load = useCallback(async () => {
    try {
      const { entities } = await bgEntitiesService.list()
      const mine = entities.filter((e) => e.type === 'shell' && e.spawned_by_task_id === taskId)
      // running 置顶，其余按启动时间倒序
      mine.sort((a, b) => {
        if ((a.status === 'running') !== (b.status === 'running')) return a.status === 'running' ? -1 : 1
        return b.spawned_at.localeCompare(a.spawned_at)
      })
      setShells(mine)
    } catch {
      /* trace 详情里静默失败，不打断主面板 */
    } finally {
      setLoaded(true)
    }
  }, [taskId])

  const hasRunning = shells.some((s) => s.status === 'running')

  useEffect(() => { void load() }, [load])

  // 只有还有 running shell 时才轮询——终态 shell 不会再变（同 LogModal 的做法）。
  useEffect(() => {
    if (!hasRunning) return
    const id = setInterval(() => { void load() }, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [hasRunning, load])

  const handleKillConfirm = async () => {
    if (!killTarget) return
    setKilling(true)
    try {
      await bgEntitiesService.kill(killTarget.entity_id)
      setKillTarget(null)
      await load()
    } finally {
      setKilling(false)
    }
  }

  // 无 shell（或还没加载完且为空）→ 不渲染，保持 trace 详情干净
  if (!loaded || shells.length === 0) return null

  const running = shells.filter((s) => s.status === 'running')
  const terminalCount = shells.length - running.length
  const visible = showTerminal ? shells : running

  return (
    <div style={{ marginTop: 12 }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
          marginBottom: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: running.length ? '#10b981' : 'var(--text-muted)' }} />
        后台 shell · 本 task
        <span style={{ color: 'var(--text-muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
          · {running.length} 运行中 / 共 {shells.length}
        </span>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: 76 }} />
          <col />
          <col style={{ width: 96 }} />
          <col style={{ width: 132 }} />
        </colgroup>
        <tbody>
          {visible.map((s) => {
            const isRunning = s.status === 'running'
            return (
            <tr
              key={s.entity_id}
              style={{
                borderBottom: '1px solid var(--border)',
                background: isRunning ? 'rgba(16,185,129,0.05)' : 'transparent',
                opacity: isRunning ? 1 : 0.6,
              }}
            >
              <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                <span
                  style={{
                    background: `${bgStatusColor(s.status)}22`,
                    color: bgStatusColor(s.status),
                    borderRadius: 3,
                    padding: '2px 7px',
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  {bgStatusLabel(s.status)}
                </span>
              </td>
              <td
                title={s.command}
                style={{
                  padding: '8px 10px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {s.command || '-'}
              </td>
              <td style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>
                {bgFormatRuntime(s)}{exitSuffix(s)}
              </td>
              <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', textAlign: 'right' }}>
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <Button variant="secondary" onClick={() => setLogEntity(s)}>查看详情</Button>
                  {isRunning && (
                    <Button variant="danger" onClick={() => setKillTarget(s)}>停止</Button>
                  )}
                </div>
              </td>
            </tr>
            )
          })}
        </tbody>
      </table>

      {terminalCount > 0 && (
        <div
          onClick={() => setShowTerminal((v) => !v)}
          style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}
        >
          {showTerminal ? '▾' : '▸'} 已结束 {terminalCount}（task 完成后会被 GC 清理）
        </div>
      )}

      <LogModal entity={logEntity} onClose={() => setLogEntity(null)} />

      <ConfirmModal
        open={!!killTarget}
        title="停止后台 shell"
        message={`确定停止 ${killTarget?.entity_id.slice(0, 12)}…（命令：${(killTarget?.command ?? '').slice(0, 60)}）吗？`}
        confirmText="停止"
        confirmVariant="danger"
        loading={killing}
        onConfirm={handleKillConfirm}
        onCancel={() => setKillTarget(null)}
      />
    </div>
  )
}
