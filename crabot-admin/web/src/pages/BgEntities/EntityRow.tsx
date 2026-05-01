import React from 'react'
import { Button } from '../../components/Common/Button'
import type { BgEntity } from '../../services/bg-entities'

// ============================================================================
// 辅助函数
// ============================================================================

function formatSpawnedAt(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) {
    const time = new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    return `今天 ${time}`
  }
  return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatRuntime(entity: BgEntity): string {
  const startMs = new Date(entity.spawned_at).getTime()
  const endMs = entity.ended_at ? new Date(entity.ended_at).getTime() : Date.now()
  const diff = endMs - startMs
  if (diff < 0) return '-'
  if (diff < 60_000) return `${Math.round(diff / 1000)}s`
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ${Math.round((diff % 60_000) / 1000)}s`
  return `${Math.floor(diff / 3600_000)}h ${Math.floor((diff % 3600_000) / 60_000)}m`
}

function statusColor(status: BgEntity['status']): string {
  switch (status) {
    case 'running': return '#10b981'
    case 'completed': return '#6b7280'
    case 'failed': return '#ef4444'
    case 'killed': return '#f59e0b'
    case 'stalled': return '#f97316'
    default: return '#6b7280'
  }
}

function statusLabel(status: BgEntity['status']): string {
  switch (status) {
    case 'running': return '运行中'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'killed': return '已停止'
    case 'stalled': return '停滞'
    default: return status
  }
}

function typeLabel(type: BgEntity['type']): string {
  return type === 'shell' ? 'Shell' : 'Agent'
}

function typeBg(type: BgEntity['type']): string {
  return type === 'shell' ? '#3b82f6' : '#8b5cf6'
}

function descriptionText(entity: BgEntity): string {
  const text = entity.type === 'shell' ? entity.command : entity.task_description
  if (!text) return '-'
  return text.length > 60 ? text.slice(0, 60) + '...' : text
}

// ============================================================================
// EntityRowProps
// ============================================================================

export interface EntityRowProps {
  entity: BgEntity
  onKill: (id: string) => Promise<void>
  onViewLog: (id: string) => void
}

export const EntityRow: React.FC<EntityRowProps> = ({ entity, onKill, onViewLog }) => {
  const [killing, setKilling] = React.useState(false)

  const handleKill = async () => {
    setKilling(true)
    try {
      await onKill(entity.entity_id)
    } finally {
      setKilling(false)
    }
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      {/* 类型 */}
      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
        <span
          style={{
            background: typeBg(entity.type),
            color: '#fff',
            borderRadius: 3,
            padding: '2px 7px',
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {typeLabel(entity.type)}
        </span>
      </td>

      {/* 实体 ID */}
      <td
        style={{
          padding: '10px 12px',
          fontFamily: 'monospace',
          fontSize: 12,
          color: 'var(--text-secondary)',
          whiteSpace: 'nowrap',
        }}
        title={entity.entity_id}
      >
        {entity.entity_id.slice(0, 12)}...
      </td>

      {/* 状态 */}
      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
        <span
          style={{
            background: `${statusColor(entity.status)}22`,
            color: statusColor(entity.status),
            borderRadius: 3,
            padding: '2px 7px',
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {statusLabel(entity.status)}
        </span>
      </td>

      {/* 命令 / 任务 */}
      <td
        style={{
          padding: '10px 12px',
          fontSize: 12,
          color: 'var(--text-primary)',
          maxWidth: 280,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={entity.type === 'shell' ? entity.command : entity.task_description}
      >
        {descriptionText(entity)}
      </td>

      {/* 启动时间 */}
      <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
        {formatSpawnedAt(entity.spawned_at)}
      </td>

      {/* 已运行时长 */}
      <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
        {formatRuntime(entity)}
      </td>

      {/* 操作 */}
      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button
            variant="secondary"
            onClick={() => onViewLog(entity.entity_id)}
          >
            查看日志
          </Button>
          {entity.status === 'running' && (
            <Button
              variant="danger"
              onClick={handleKill}
              disabled={killing}
            >
              {killing ? '停止中...' : '停止'}
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}
