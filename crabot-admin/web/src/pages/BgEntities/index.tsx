import React, { useState, useEffect, useCallback, useRef } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { ConfirmModal } from '../../components/Common/ConfirmModal'
import { useToast } from '../../contexts/ToastContext'
import { bgEntitiesService, type BgEntity } from '../../services/bg-entities'
import { EntityRow } from './EntityRow'
import { LogModal } from './LogModal'

// ============================================================================
// BgEntitiesPage
// ============================================================================

const BgEntitiesPage: React.FC = () => {
  const toast = useToast()
  const [entities, setEntities] = useState<BgEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [logEntityId, setLogEntityId] = useState<string | null>(null)
  const [killTarget, setKillTarget] = useState<BgEntity | null>(null)
  const [killing, setKilling] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Filters
  const [statusFilter, setStatusFilter] = useState<BgEntity['status'] | ''>('')
  const [typeFilter, setTypeFilter] = useState<BgEntity['type'] | ''>('')

  const loadEntities = useCallback(async () => {
    try {
      const result = await bgEntitiesService.list()
      setEntities(result.entities)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`加载失败: ${msg}`)
    } finally {
      setLoading(false)
    }
  }, [toast])

  // Initial load
  useEffect(() => {
    loadEntities()
  }, [loadEntities])

  // 5s auto polling
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => {
      bgEntitiesService.list()
        .then(result => setEntities(result.entities))
        .catch(() => {})
    }, 5000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const handleKillConfirm = async () => {
    if (!killTarget) return
    setKilling(true)
    try {
      await bgEntitiesService.kill(killTarget.entity_id)
      toast.success('已发送停止指令')
      setKillTarget(null)
      await loadEntities()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '停止失败')
    } finally {
      setKilling(false)
    }
  }

  // EntityRow.onKill opens a confirm modal; the actual kill is in handleKillConfirm.
  const handleKillFromRow = useCallback((id: string): Promise<void> => {
    setEntities(prev => {
      const entity = prev.find(e => e.entity_id === id)
      if (entity) setKillTarget(entity)
      return prev
    })
    return Promise.resolve()
  }, [])

  const filteredEntities = entities.filter(e => {
    if (statusFilter && e.status !== statusFilter) return false
    if (typeFilter && e.type !== typeFilter) return false
    return true
  })

  const runningCount = entities.filter(e => e.status === 'running').length

  if (loading) {
    return (
      <MainLayout>
        <Loading />
      </MainLayout>
    )
  }

  return (
    <MainLayout>
      {/* Header */}
      <div
        style={{
          marginBottom: '1.5rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div>
          <h1
            style={{
              fontSize: '1.75rem',
              fontWeight: 700,
              fontFamily: 'var(--font-display)',
              letterSpacing: '-0.02em',
            }}
          >
            长跑实体
          </h1>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            共 {entities.length} 个实体
            {runningCount > 0 && <span style={{ color: '#10b981', marginLeft: 6 }}>/ {runningCount} 个运行中</span>}
          </p>
        </div>
        <Button variant="secondary" onClick={() => loadEntities()}>
          刷新
        </Button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: '1.25rem', alignItems: 'center' }}>
        <select
          className="select"
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as BgEntity['status'] | '')}
          style={{ minWidth: 120 }}
        >
          <option value="">全部状态</option>
          <option value="running">运行中</option>
          <option value="completed">已完成</option>
          <option value="failed">失败</option>
          <option value="killed">已停止</option>
          <option value="stalled">停滞</option>
        </select>
        <select
          className="select"
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value as BgEntity['type'] | '')}
          style={{ minWidth: 100 }}
        >
          <option value="">全部类型</option>
          <option value="shell">Shell</option>
          <option value="agent">Agent</option>
        </select>
      </div>

      {/* Table */}
      {filteredEntities.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '48px 24px',
            color: 'var(--text-secondary)',
            fontSize: 14,
          }}
        >
          {entities.length === 0 ? '当前无活跃的长跑实体' : '没有符合筛选条件的实体'}
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 13,
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: '1px solid var(--border)',
                  background: 'var(--bg-secondary, #f9fafb)',
                  textAlign: 'left',
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                <th style={{ padding: '8px 12px' }}>类型</th>
                <th style={{ padding: '8px 12px' }}>实体 ID</th>
                <th style={{ padding: '8px 12px' }}>状态</th>
                <th style={{ padding: '8px 12px' }}>命令 / 任务</th>
                <th style={{ padding: '8px 12px' }}>启动时间</th>
                <th style={{ padding: '8px 12px' }}>已运行</th>
                <th style={{ padding: '8px 12px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredEntities.map(entity => (
                <EntityRow
                  key={entity.entity_id}
                  entity={entity}
                  onKill={handleKillFromRow}
                  onViewLog={setLogEntityId}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Log Modal */}
      <LogModal
        entityId={logEntityId}
        onClose={() => setLogEntityId(null)}
      />

      {/* Kill Confirm Modal */}
      <ConfirmModal
        open={!!killTarget}
        title="停止实体"
        message={`确定要停止实体 ${killTarget?.entity_id.slice(0, 12)}... 吗？`}
        confirmText="停止"
        confirmVariant="danger"
        loading={killing}
        onConfirm={handleKillConfirm}
        onCancel={() => setKillTarget(null)}
      />
    </MainLayout>
  )
}

export default BgEntitiesPage
