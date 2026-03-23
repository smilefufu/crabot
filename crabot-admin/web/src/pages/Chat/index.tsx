import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MainLayout } from '../../components/Layout/MainLayout'
import { chatService } from '../../services/chat'
import type { ChatMessage, ChatServerMessage, ConnectionStatus } from '../../types/chat'

/** 消息状态 */
interface MessageState extends ChatMessage {
  status?: 'sending' | 'sent' | 'processing' | 'completed' | 'failed'
  reply_type?: 'direct_reply' | 'task_created' | 'task_completed' | 'task_failed'
  error?: string
}

const PAGE_SIZE = 30

export const Chat: React.FC = () => {
  const [messages, setMessages] = useState<MessageState[]>([])
  const [input, setInput] = useState('')
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(chatService.status)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const isLoadingHistoryRef = useRef(false)
  const isNearBottomRef = useRef(true)
  const navigate = useNavigate()

  // 检测滚动位置
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current
    if (!container) return
    const threshold = 100
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    const nearBottom = distanceFromBottom < threshold
    isNearBottomRef.current = nearBottom
    setShowScrollButton(!nearBottom)
    if (nearBottom) {
      setUnreadCount(0)
    }
  }, [])

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    setUnreadCount(0)
    setShowScrollButton(false)
  }, [])

  // 连接 WebSocket
  useEffect(() => {
    if (connectionStatus === 'disconnected' || connectionStatus === 'error') {
      chatService.connect()
    }

    const unsubStatus = chatService.onStatusChange((status) => {
      setConnectionStatus(status)
      // 重连成功后用 API 检查并更新 processing 状态的消息
      if (status === 'connected') {
        chatService.loadHistory(PAGE_SIZE).then((history) => {
          if (history.length === 0) return
          const historyMap = new Map(history.map((m) => [m.message_id, m]))
          setMessages((prev) => {
            const hasStuck = prev.some((m) => m.status === 'processing')
            if (!hasStuck) return prev
            return prev.map((m) => {
              if (m.status !== 'processing') return m
              const found = historyMap.get(m.message_id)
              if (found) return { ...found, status: 'completed' as const }
              // 通过 request_id 匹配（占位消息的 message_id 是临时生成的）
              const byReqId = history.find((h) => h.request_id === m.request_id && h.role === 'assistant')
              if (byReqId) return { ...byReqId, status: 'completed' as const }
              return m
            })
          })
        }).catch(() => {/* ignore */})
      }
    })
    const unsubMessage = chatService.onMessage(handleServerMessage)

    // 轮询修复：每 8 秒检查是否有 processing 超过 15 秒的消息
    // 用于修复 WS 连通但 chat_reply 事件丢失的情况
    const stuckMessageTimes = new Map<string, number>()
    const pollInterval = setInterval(() => {
      setMessages((prev) => {
        const now = Date.now()
        const hasStuck = prev.some((m) => {
          if (m.status !== 'processing') return false
          const firstSeen = stuckMessageTimes.get(m.message_id)
          if (!firstSeen) {
            stuckMessageTimes.set(m.message_id, now)
            return false
          }
          return now - firstSeen > 15000
        })
        if (!hasStuck) return prev
        // 有卡住的消息，从 API 加载最近消息，精确更新 processing 的
        chatService.loadHistory(PAGE_SIZE).then((history) => {
          if (history.length === 0) return
          setMessages((current) => {
            const stillStuck = current.some((m) => m.status === 'processing')
            if (!stillStuck) return current
            return current.map((m) => {
              if (m.status !== 'processing') return m
              const byReqId = history.find((h) => h.request_id === m.request_id && h.role === 'assistant')
              if (byReqId) return { ...byReqId, status: 'completed' as const }
              return m
            })
          })
        }).catch(() => {/* ignore */})
        return prev
      })
    }, 8000)

    return () => {
      unsubStatus()
      unsubMessage()
      clearInterval(pollInterval)
    }
  }, [])

  // 加载历史消息
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const history = await chatService.loadHistory(PAGE_SIZE)
        if (history.length > 0) {
          // API 返回倒序（最新在前），UI 需要正序（最旧在前）
          const chronological = [...history].reverse()
          setMessages(chronological.map((msg) => ({ ...msg, status: 'completed' as const })))
        }
        if (history.length < PAGE_SIZE) {
          setHasMore(false)
        }
      } catch (error) {
        console.error('Failed to load chat history:', error)
      }
    }
    loadHistory()
  }, [])

  // 自动滚动到底部（仅用户在底部附近时）
  useEffect(() => {
    if (isLoadingHistoryRef.current) return
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    } else {
      // 用户在浏览历史，累计未读新消息数
      const lastMsg = messages[messages.length - 1]
      if (lastMsg && (lastMsg.role === 'assistant' || lastMsg.status === 'sent')) {
        setUnreadCount((prev) => prev + 1)
      }
    }
  }, [messages])

  // 加载更早的消息
  const loadOlderMessages = useCallback(async () => {
    if (!hasMore || loadingMore) return
    const oldest = messages[0]
    if (!oldest) return

    setLoadingMore(true)
    isLoadingHistoryRef.current = true

    const container = messagesContainerRef.current
    const prevScrollHeight = container?.scrollHeight ?? 0

    try {
      const older = await chatService.loadHistory(PAGE_SIZE, oldest.timestamp)
      if (older.length < PAGE_SIZE) {
        setHasMore(false)
      }
      if (older.length > 0) {
        const chronological = [...older].reverse()
        setMessages((prev) => [
          ...chronological.map((msg) => ({ ...msg, status: 'completed' as const })),
          ...prev,
        ])
        // 保持滚动位置：等 DOM 更新后调整 scrollTop
        requestAnimationFrame(() => {
          if (container) {
            const newScrollHeight = container.scrollHeight
            container.scrollTop = newScrollHeight - prevScrollHeight
          }
          setLoadingMore(false)
          isLoadingHistoryRef.current = false
        })
        return
      }
    } catch (error) {
      console.error('Failed to load older messages:', error)
    }
    setLoadingMore(false)
    isLoadingHistoryRef.current = false
  }, [hasMore, loadingMore, messages])

  // IntersectionObserver 检测滚动到顶部
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMore) {
          loadOlderMessages()
        }
      },
      { root: messagesContainerRef.current, threshold: 0.1 }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loadingMore, loadOlderMessages])

  // 处理服务端消息
  const handleServerMessage = (message: ChatServerMessage) => {
    if (message.type === 'chat_reply') {
      setMessages((prev) => {
        // 找到对应的 request 并更新状态
        const existingIndex = prev.findIndex(
          (m) => m.request_id === message.request_id && m.role === 'assistant'
        )

        if (existingIndex >= 0) {
          // 更新现有消息
          const updated = [...prev]
          updated[existingIndex] = {
            ...updated[existingIndex],
            content: message.content,
            status: message.status === 'completed' ? 'completed' : 'failed',
            reply_type: message.reply_type,
            task_id: message.task_id,
          }
          return updated
        }

        // 添加新的 assistant 消息
        return [
          ...prev,
          {
            message_id: `msg_${Date.now()}`,
            role: 'assistant' as const,
            content: message.content,
            request_id: message.request_id,
            task_id: message.task_id,
            reply_type: message.reply_type,
            timestamp: new Date().toISOString(),
            status: message.status === 'completed' ? 'completed' : 'failed',
          },
        ]
      })
    } else if (message.type === 'chat_status') {
      // 只更新 assistant 占位消息的状态为 processing
      setMessages((prev) =>
        prev.map((m) =>
          m.request_id === message.request_id && m.role === 'assistant'
            ? { ...m, status: 'processing' as const }
            : m
        )
      )
    } else if (message.type === 'chat_error') {
      if (message.request_id) {
        setMessages((prev) =>
          prev.map((m) =>
            m.request_id === message.request_id
              ? { ...m, status: 'failed' as const, error: message.error }
              : m
          )
        )
      }
    }
  }

  // 发送消息
  const handleSend = () => {
    const content = input.trim()
    if (!content || connectionStatus !== 'connected') return

    try {
      const request_id = chatService.sendMessage(content)

      // 添加用户消息
      const userMessage: MessageState = {
        message_id: `msg_${Date.now()}`,
        role: 'user',
        content,
        request_id,
        timestamp: new Date().toISOString(),
        status: 'sent',
      }

      // 添加占位的 assistant 消息
      const assistantPlaceholder: MessageState = {
        message_id: `msg_${Date.now()}_assistant`,
        role: 'assistant',
        content: '',
        request_id,
        timestamp: new Date().toISOString(),
        status: 'processing',
      }

      setMessages((prev) => [...prev, userMessage, assistantPlaceholder])
      setInput('')

      // 聚焦输入框
      inputRef.current?.focus()
    } catch (error) {
      console.error('Failed to send message:', error)
    }
  }

  // 处理键盘事件
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // 重连
  const handleReconnect = () => {
    chatService.connect()
  }

  // 连接状态指示器
  const renderConnectionStatus = () => {
    const statusConfig: Record<ConnectionStatus, { color: string; text: string }> = {
      connecting: { color: '#f59e0b', text: '连接中...' },
      connected: { color: '#10b981', text: '已连接' },
      disconnected: { color: '#94a3b8', text: '已断开' },
      error: { color: '#ef4444', text: '连接错误' },
    }

    const config = statusConfig[connectionStatus]

    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <div
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: config.color,
          }}
        />
        <span style={{ fontSize: '0.85rem', color: config.color }}>{config.text}</span>
        {(connectionStatus === 'disconnected' || connectionStatus === 'error') && (
          <button
            onClick={handleReconnect}
            style={{
              padding: '0.25rem 0.5rem',
              fontSize: '0.8rem',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              color: 'var(--text-primary)',
              cursor: 'pointer',
            }}
          >
            重连
          </button>
        )}
      </div>
    )
  }

  // 渲染消息
  const renderMessage = (message: MessageState) => {
    const isUser = message.role === 'user'
    const isProcessing = message.status === 'processing'

    // reply_type 对应的提示信息
    const getReplyTypeHint = () => {
      if (!message.reply_type || message.reply_type === 'direct_reply') return null

      const hints = {
        task_created: { text: '✓ 任务已创建，正在后台执行', color: 'var(--primary)' },
        task_completed: { text: '✓ 任务已完成', color: 'var(--success)' },
        task_failed: { text: '✗ 任务执行失败', color: 'var(--error)' },
      }

      const hint = hints[message.reply_type]
      if (!hint) return null

      return (
        <div
          style={{
            fontSize: '0.85rem',
            color: hint.color,
            marginBottom: '0.5rem',
            fontWeight: 500,
          }}
        >
          {hint.text}
        </div>
      )
    }

    return (
      <div
        key={message.message_id}
        style={{
          display: 'flex',
          justifyContent: isUser ? 'flex-end' : 'flex-start',
          marginBottom: '1rem',
        }}
      >
        <div
          style={{
            maxWidth: '80%',
            padding: '0.75rem 1rem',
            borderRadius: '12px',
            backgroundColor: isUser ? 'var(--primary)' : 'var(--bg-secondary)',
            color: isUser ? 'white' : 'var(--text-primary)',
            border: isUser ? 'none' : '1px solid var(--border)',
          }}
        >
          {isProcessing ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div className="spinner" style={{ width: '16px', height: '16px', borderWidth: '2px' }} />
              <span style={{ color: 'var(--text-secondary)' }}>思考中...</span>
            </div>
          ) : (
            <>
              {getReplyTypeHint()}
              <div
                className="markdown-content"
                style={{
                  wordBreak: 'break-word',
                  lineHeight: '1.6',
                }}
              >
                {isUser ? (
                  <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                )}
              </div>
              {message.task_id && (
                <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
                  <button
                    onClick={() => navigate(`/tasks/${message.task_id}`)}
                    style={{
                      padding: '0.4rem 0.8rem',
                      fontSize: '0.85rem',
                      background: 'var(--primary)',
                      color: 'white',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontWeight: 500,
                    }}
                  >
                    查看任务详情 →
                  </button>
                </div>
              )}
              {message.error && (
                <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--error)' }}>
                  {message.error}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <MainLayout>
      <div
        style={{
          height: 'calc(100vh - 4rem)',
          display: 'flex',
          flexDirection: 'column',
          padding: '2rem',
        }}
      >
        {/* 头部 */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '1rem',
          }}
        >
          <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>聊天</h1>
          {renderConnectionStatus()}
        </div>

        {/* 消息区域 */}
        <div style={{ flex: 1, position: 'relative', marginBottom: '1rem' }}>
          <div
            ref={messagesContainerRef}
            onScroll={handleScroll}
            style={{
              height: '100%',
              overflowY: 'auto',
              padding: '1rem',
              backgroundColor: 'var(--bg-primary)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
            }}
          >
          {messages.length === 0 ? (
            <div
              style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-secondary)',
              }}
            >
              开始与 AI 助手对话吧！
            </div>
          ) : (
            <>
              {/* 顶部哨兵：触发加载更多 */}
              <div ref={sentinelRef} style={{ height: '1px' }} />
              {loadingMore && (
                <div style={{ textAlign: 'center', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                  <div className="spinner" style={{ width: '16px', height: '16px', borderWidth: '2px', display: 'inline-block', verticalAlign: 'middle' }} />
                  <span style={{ marginLeft: '0.5rem', fontSize: '0.85rem' }}>加载更多...</span>
                </div>
              )}
              {!hasMore && messages.length > 0 && (
                <div style={{ textAlign: 'center', padding: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                  已加载全部消息
                </div>
              )}
              {messages.map(renderMessage)}
              <div ref={messagesEndRef} />
            </>
          )}
          </div>

          {/* 回到最新按钮 */}
          {showScrollButton && (
            <button
              onClick={scrollToBottom}
              style={{
                position: 'absolute',
                bottom: '1rem',
                left: '50%',
                transform: 'translateX(-50%)',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.5rem 1rem',
                backgroundColor: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
                borderRadius: '20px',
                cursor: 'pointer',
                fontSize: '0.85rem',
                fontWeight: 500,
                boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                zIndex: 10,
                transition: 'opacity 0.2s',
              }}
            >
              <span style={{ fontSize: '1rem' }}>↓</span>
              {unreadCount > 0 ? `${unreadCount} 条新消息` : '回到最新'}
            </button>
          )}
        </div>

        {/* 输入区域 */}
        <div
          style={{
            display: 'flex',
            gap: '1rem',
            padding: '1rem',
            backgroundColor: 'var(--bg-secondary)',
            borderRadius: '8px',
            border: '1px solid var(--border)',
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={connectionStatus === 'connected' ? '输入消息...' : '等待连接...'}
            disabled={connectionStatus !== 'connected'}
            className="input"
            style={{ flex: 1 }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || connectionStatus !== 'connected'}
            className="btn btn-primary"
            style={{ padding: '0.75rem 1.5rem' }}
          >
            发送
          </button>
        </div>
      </div>
    </MainLayout>
  )
}