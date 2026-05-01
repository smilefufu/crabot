import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '../../components/Common/Button'
import { bgEntitiesService } from '../../services/bg-entities'

// ============================================================================
// LogModalProps
// ============================================================================

export interface LogModalProps {
  entityId: string | null
  onClose: () => void
}

// ============================================================================
// LogModal
// ============================================================================

export const LogModal: React.FC<LogModalProps> = ({ entityId, onClose }) => {
  const [logContent, setLogContent] = useState('')
  const [status, setStatus] = useState('')
  const [type, setType] = useState('')
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const currentOffsetRef = useRef(0)

  const fetchLog = useCallback(async (fromOffset: number, isInitial: boolean) => {
    if (!entityId) return
    if (isInitial) setLoading(true)
    else setRefreshing(true)
    try {
      const result = await bgEntitiesService.getLog(entityId, fromOffset)
      setStatus(result.status)
      setType(result.type)
      if (isInitial) {
        setLogContent(result.content)
      } else if (result.content) {
        setLogContent(prev => prev + result.content)
      }
      currentOffsetRef.current = result.new_offset
      // Auto-scroll to bottom
      if (logRef.current) {
        logRef.current.scrollTop = logRef.current.scrollHeight
      }
    } catch {
      // silently ignore polling errors
    } finally {
      if (isInitial) setLoading(false)
      else setRefreshing(false)
    }
  }, [entityId])

  // Initial load + setup polling for running entities
  useEffect(() => {
    if (!entityId) return

    // Reset state
    setLogContent('')
    currentOffsetRef.current = 0
    setStatus('')
    setType('')

    // Initial fetch
    fetchLog(0, true)

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [entityId, fetchLog])

  // Setup/teardown polling when status changes to/from 'running'
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }

    if (status === 'running' && entityId) {
      pollRef.current = setInterval(() => {
        fetchLog(currentOffsetRef.current, false)
      }, 5000)
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [status, entityId, fetchLog])

  const handleRefresh = () => {
    fetchLog(currentOffsetRef.current, false)
  }

  const handleClose = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    onClose()
  }

  // Scroll to bottom on new content
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logContent])

  if (!entityId) return null

  return (
    <div
      className="modal-overlay"
      onClick={handleClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-primary, #fff)',
          borderRadius: 8,
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          width: '90vw',
          maxWidth: 900,
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 15 }}>实体日志</span>
          {type && (
            <span
              style={{
                background: type === 'shell' ? '#3b82f620' : '#8b5cf620',
                color: type === 'shell' ? '#3b82f6' : '#8b5cf6',
                borderRadius: 3,
                padding: '2px 7px',
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {type === 'shell' ? 'Shell' : 'Agent'}
            </span>
          )}
          {status && (
            <span
              style={{
                background: status === 'running' ? '#10b98120' : status === 'failed' ? '#ef444420' : '#6b728020',
                color: status === 'running' ? '#10b981' : status === 'failed' ? '#ef4444' : '#6b7280',
                borderRadius: 3,
                padding: '2px 7px',
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {status === 'running' ? '运行中' : status === 'completed' ? '已完成' : status === 'failed' ? '失败' : status === 'killed' ? '已停止' : status === 'stalled' ? '停滞' : status}
            </span>
          )}
          {status === 'running' && (
            <span style={{ fontSize: 11, color: '#10b981' }}>
              ● 自动刷新中
            </span>
          )}
          <div style={{ flex: 1 }} />
          <Button
            variant="secondary"
            onClick={handleRefresh}
            disabled={refreshing || loading}
          >
            {refreshing ? '刷新中...' : '刷新'}
          </Button>
          <button
            onClick={handleClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 20,
              color: 'var(--text-secondary)',
              lineHeight: 1,
              padding: '0 4px',
            }}
          >
            ×
          </button>
        </div>

        {/* Log Content */}
        <div style={{ flex: 1, overflow: 'hidden', padding: 16 }}>
          {loading ? (
            <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>加载中...</div>
          ) : (
            <pre
              ref={logRef}
              style={{
                margin: 0,
                fontFamily: 'monospace',
                fontSize: 12,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                overflowY: 'auto',
                maxHeight: '60vh',
                background: 'var(--bg-secondary, #f9fafb)',
                padding: 12,
                borderRadius: 4,
                color: 'var(--text-primary)',
              }}
            >
              {logContent || '（暂无日志内容）'}
            </pre>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '10px 20px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <Button variant="secondary" onClick={handleClose}>
            关闭
          </Button>
        </div>
      </div>
    </div>
  )
}
