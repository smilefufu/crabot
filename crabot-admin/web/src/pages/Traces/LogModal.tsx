import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Modal } from '../../components/Common/Modal'
import { Button } from '../../components/Common/Button'
import { bgEntitiesService, bgStatusLabel, type BgEntity } from '../../services/bg-entities'

export interface LogModalProps {
  /** 要查看的实体；null 时关闭。调用方持有整个对象，元信息（命令等）随它一起传入。 */
  entity: BgEntity | null
  onClose: () => void
}

type LogStatus = '' | 'running' | 'completed' | 'failed' | 'killed' | 'stalled' | string

const STATUS_TONE: Record<string, 'success' | 'error' | 'muted'> = {
  running: 'success',
  completed: 'muted',
  failed: 'error',
  killed: 'muted',
  stalled: 'muted',
}

export const LogModal: React.FC<LogModalProps> = ({ entity, onClose }) => {
  const entityId = entity?.entity_id ?? null
  const command = entity?.command
  const [logContent, setLogContent] = useState('')
  const [status, setStatus] = useState<LogStatus>('')
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

  useEffect(() => {
    if (!entityId) return
    setLogContent('')
    currentOffsetRef.current = 0
    setStatus('')
    setType('')
    fetchLog(0, true)
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [entityId, fetchLog])

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

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logContent])

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

  const statusTone = STATUS_TONE[status] ?? 'muted'

  return (
    <Modal
      open={!!entityId}
      onClose={handleClose}
      size="lg"
      ariaLabel="实体日志"
      hideCloseButton
      contentClassName="log-modal"
      title={
        <span className="log-modal__title-row">
          <span className="log-modal__title-text">实体详情</span>
          {type && (
            <span className={`log-modal__tag log-modal__tag--${type === 'shell' ? 'shell' : 'agent'}`}>
              {type === 'shell' ? 'Shell' : 'Agent'}
            </span>
          )}
          {status && (
            <span className={`log-modal__status log-modal__status--${statusTone}`}>
              {bgStatusLabel(status)}
            </span>
          )}
          {status === 'running' && (
            <span className="log-modal__autorefresh">● 自动刷新中</span>
          )}
          <span className="log-modal__title-spacer" />
          <Button
            variant="secondary"
            onClick={handleRefresh}
            disabled={refreshing || loading}
          >
            {refreshing ? '刷新中…' : '刷新'}
          </Button>
          <button
            type="button"
            className="modal-close log-modal__close"
            onClick={handleClose}
            aria-label="关闭"
          >
            ✕
          </button>
        </span>
      }
      footer={
        <Button variant="secondary" onClick={handleClose}>关闭</Button>
      }
    >
      <div className="log-modal__body">
        {command && (
          <div style={{ marginBottom: 10 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--text-muted)',
                marginBottom: 4,
              }}
            >
              命令
            </div>
            <code
              style={{
                display: 'block',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                lineHeight: 1.5,
                color: 'var(--text-primary)',
                background: 'var(--bg-primary)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '8px 10px',
                maxHeight: 140,
                overflowY: 'auto',
              }}
            >
              {command}
            </code>
          </div>
        )}
        {loading ? (
          <div className="log-modal__loading">加载中…</div>
        ) : (
          <pre ref={logRef} className="log-modal__pre">
            {logContent || '（暂无日志内容）'}
          </pre>
        )}
      </div>
    </Modal>
  )
}
