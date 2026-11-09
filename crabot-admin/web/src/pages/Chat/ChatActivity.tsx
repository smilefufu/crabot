import { useEffect, useState } from 'react'
import type { ConnectionStatus } from '../../types/chat'
import './ChatActivity.css'

export interface PendingChatRequest {
  phase: 'sending' | 'waiting' | 'unknown'
  sentAt: number
}

export function ChatActivity({ requests, connectionStatus }: {
  requests: ReadonlyMap<string, PendingChatRequest>
  connectionStatus: ConnectionStatus
}) {
  const [, tick] = useState(0)
  const pending = [...requests.values()]
  const waiting = pending.filter(request => request.phase !== 'sending')
  const deadline = Math.max(0, ...waiting.filter(request => request.phase === 'waiting').map(request => request.sentAt + 60_000))
  useEffect(() => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return
    const timer = setTimeout(() => tick(value => value + 1), remaining)
    return () => clearTimeout(timer)
  }, [deadline])

  if (!pending.length) return null
  const connected = connectionStatus === 'connected'
  const thinking = connected && deadline > Date.now()
  const text = !connected ? '连接中断，回复状态暂无法确认'
    : thinking ? 'Crabot 思考中…'
    : waiting.some(request => request.phase === 'unknown') ? '回复状态暂无法确认'
    : '仍在等待回复'

  return (
    <div className="chat-activity" role="status" aria-live="polite">
      {pending.some(request => request.phase === 'sending') && <span>正在发送…</span>}
      {waiting.length > 0 && (
        <span className="chat-activity-row" data-thinking={thinking}>
          <span className="chat-activity-dots" aria-hidden="true"><i /><i /><i /></span>
          <span>{text}</span>
        </span>
      )}
    </div>
  )
}
