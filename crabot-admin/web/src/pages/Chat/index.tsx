import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { chatService } from '../../services/chat'
import type { ChatMessageContent, ChatServerMessage, ChatTaskSnapshot, ConnectionStatus } from '../../types/chat'
import { ChatSettingsModal } from './ChatSettingsModal'
import { ConfirmModal } from '../../components/Common/ConfirmModal'
import { useToast } from '../../contexts/ToastContext'
import { ChatMessageItem, type MessageState } from './ChatMessageItem'
import { MessageContextMenu } from './MessageContextMenu'

const PAGE_SIZE = 30

/** 同一本地日判定 */
function sameLocalDay(a: string, b: string): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate()
}

/** 日期分隔标签：今天 / 昨天 / yyyy年M月d日 */
function formatDateLabel(ts: string): string {
  const d = new Date(ts)
  const now = new Date()
  if (sameLocalDay(ts, now.toISOString())) return '今天'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameLocalDay(ts, yesterday.toISOString())) return '昨天'
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

export const Chat: React.FC = () => {
  const toast = useToast()
  const [messages, setMessages] = useState<MessageState[]>([])
  // 消息级任务图标数据（task_id → 快照，终态也保留供图标显示 ✓/✗）
  const [taskStatuses, setTaskStatuses] = useState<Map<string, ChatTaskSnapshot>>(new Map())
  const [input, setInput] = useState('')
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(chatService.status)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [attachments, setAttachments] = useState<File[]>([])
  const [isSending, setIsSending] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  // 消息引用：胶囊数据
  const [quote, setQuote] = useState<{ role: 'user' | 'assistant'; text: string } | null>(null)
  // 选中文本浮动「引用」按钮
  const [selectionQuote, setSelectionQuote] = useState<{
    x: number
    y: number
    role: 'user' | 'assistant'
    text: string
  } | null>(null)
  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; message: MessageState } | null>(null)
  // 清空历史二次确认弹窗
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [isClearingMessages, setIsClearingMessages] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // 发送键模式：'enter' = Enter 发送/Shift+Enter 换行；'mod-enter' = Enter 换行/Ctrl(Alt)+Enter 发送
  const [sendMode, setSendMode] = useState<'enter' | 'mod-enter'>(
    () => (localStorage.getItem('chat_send_mode') === 'mod-enter' ? 'mod-enter' : 'enter')
  )
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isLoadingHistoryRef = useRef(false)
  const isNearBottomRef = useRef(true)
  // 首屏定位完成标记：完成前自动滚动 effect 与顶部哨兵都不工作，
  // 防止初始 smooth 全程滚 + 哨兵在 scrollTop=0 时误触发连环加载
  const initialPositionedRef = useRef(false)
  /** upsert 一条任务快照进 taskStatuses（终态也保留） */
  const upsertTaskStatus = useCallback((task: ChatTaskSnapshot) => {
    setTaskStatuses((prev) => {
      const next = new Map(prev)
      next.set(task.task_id, task)
      return next
    })
  }, [])
  // objectURL 追踪，组件卸载时 revoke 防内存泄漏
  const objectUrlsRef = useRef<Map<string, string>>(new Map())

  // 发送/清空后复位输入框高度（自适应高度只在 onChange 时增长）
  useEffect(() => {
    if (input === '' && inputRef.current) {
      inputRef.current.style.height = 'auto'
    }
  }, [input])

  // 清理 objectURL（组件卸载）
  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      objectUrlsRef.current.clear()
    }
  }, [])

  // 检测滚动位置（滚动时同步关闭右键菜单）
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
    // 滚动时关闭右键菜单（避免菜单飘离触发位置）
    setContextMenu(null)
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
      if (status === 'connected') {
        // 重连补齐：pushToClient 断连即丢，断连期间的回复与 ✓ 标记经重拉历史找回。
        // 服务端消息为权威：按 message_id 去重合并；被落库版本取代的本地乐观 user
        // 消息（msg_ 前缀临时 id，同 request_id）丢弃，未落库的乐观消息原样保留。
        chatService.loadHistory(PAGE_SIZE).then((history) => {
          if (history.length === 0) return
          setMessages((prev) => {
            const known = new Set(prev.map((m) => m.message_id))
            const fresh = [...history].reverse().filter((m) => !known.has(m.message_id))
            if (fresh.length === 0) return prev
            const settled = new Set(
              fresh.map((m) => m.request_id).filter((id): id is string => id !== undefined)
            )
            const kept = prev.filter(
              (m) => !(m.message_id.startsWith('msg_') && m.request_id !== undefined && settled.has(m.request_id))
            )
            // fresh 里可能混有本会话早先已收到回复的 user 消息（WS 文本路径前端不知道
            // 服务端 UUID，只能等重连补齐）——不能一律 concat 到队尾，按时间戳归位。
            const merged = [...kept, ...fresh.map((m) => ({ ...m, status: 'completed' as const }))]
            merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
            return merged
          })
        }).catch(() => {/* ignore */})
      }
    })
    const unsubMessage = chatService.onMessage(handleServerMessage)

    return () => {
      unsubStatus()
      unsubMessage()
    }
  }, [])

  // 加载历史消息并 hydrate 页内消息的任务快照
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const history = await chatService.loadHistory(PAGE_SIZE)
        if (history.length > 0) {
          // API 返回倒序（最新在前），UI 需要正序（最旧在前）
          const chronological = [...history].reverse()
          setMessages(chronological.map((msg) => ({ ...msg, status: 'completed' as const })))
          // hydrate：对页内消息出现的 task_id 批量拉快照（getTaskSnapshot 已有 null 处理）
          const taskIds = [...new Set(chronological.map((m) => m.task_id).filter(Boolean))] as string[]
          if (taskIds.length > 0) {
            const snapshots = await Promise.all(taskIds.map((id) => chatService.getTaskSnapshot(id)))
            snapshots.forEach((snap) => {
              if (snap) upsertTaskStatus(snap)
            })
          }
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

  // 30s 轮询兜底：刷新非终态任务快照（防丢推送；终态跳过；无非终态时跳过）
  const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
  useEffect(() => {
    const interval = setInterval(() => {
      setTaskStatuses((cur) => {
        const nonTerminal = Array.from(cur.values()).filter((t) => !TERMINAL_STATUSES.has(t.status))
        if (nonTerminal.length === 0) return cur
        Promise.all(nonTerminal.map((t) => chatService.getTaskSnapshot(t.task_id))).then((snaps) => {
          snaps.forEach((snap) => {
            if (snap) upsertTaskStatus(snap)
          })
        }).catch(() => {/* 静默忽略 */})
        return cur
      })
    }, 30000)
    return () => clearInterval(interval)
  }, [upsertTaskStatus])

  // 首屏瞬时锚定底部（同步于绘制前，无可感知滚动）
  useLayoutEffect(() => {
    if (initialPositionedRef.current) return
    if (messages.length === 0) return
    const container = messagesContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
    initialPositionedRef.current = true
  }, [messages])

  // 自动滚动到底部（仅用户在底部附近时；首屏定位由上方 useLayoutEffect 负责）
  useEffect(() => {
    if (!initialPositionedRef.current) return
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
    const prevScrollTop = container?.scrollTop ?? 0

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
        // hydrate 新加载的老消息的任务快照（taskStatuses 没有的才拉）
        const newTaskIds = [...new Set(chronological.map((m) => m.task_id).filter(Boolean))] as string[]
        if (newTaskIds.length > 0) {
          setTaskStatuses((cur) => {
            const missing = newTaskIds.filter((id) => !cur.has(id))
            if (missing.length > 0) {
              Promise.all(missing.map((id) => chatService.getTaskSnapshot(id))).then((snaps) => {
                snaps.forEach((snap) => {
                  if (snap) upsertTaskStatus(snap)
                })
              }).catch(() => {/* 静默忽略 */})
            }
            return cur
          })
        }
        // 保持滚动位置：等 DOM 更新后调整 scrollTop
        requestAnimationFrame(() => {
          if (container) {
            const newScrollHeight = container.scrollHeight
            // 保留触发时的原 scrollTop 偏移，而非假定从 0 开始
            container.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight)
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
        // 首屏定位完成前不触发——scrollTop=0 的初始渲染瞬间哨兵必然可见
        if (!initialPositionedRef.current) return
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
    if (message.type === 'chat_reply' && message.reply_type === 'task_created') {
      // task_created 单独处理：转为系统提示样式消息，避免覆盖 dispatcher 先行 direct_reply
      // WS chat_reply 的 content 仍是 string，包装成 ChatMessageContent
      setMessages((prev) => {
        const cardMsg: MessageState = {
          message_id: `msg_${Date.now()}_task`,
          role: 'assistant',
          content: { type: 'text', text: message.content },
          request_id: message.request_id,
          task_id: message.task_id,
          reply_type: 'task_created',
          timestamp: new Date().toISOString(),
          status: 'completed',
        }
        // 直接追加为独立消息（占位气泡已退役，无原地转换对象）
        return [...prev, cardMsg]
      })
      // task_created：本地 upsert 初始快照 + tag 同 request_id 的 user 消息
      if (message.task_id) {
        const newTask: ChatTaskSnapshot = {
          task_id: message.task_id,
          status: 'executing',
          title: (message.content ?? '').replace(/^已创建任务：/, ''),
        }
        upsertTaskStatus(newTask)
        // 同 request_id 的 user 消息打标（本地消息列表）
        setMessages((prev) =>
          prev.map((m) =>
            m.request_id === message.request_id && m.role === 'user' && !m.task_id
              ? { ...m, task_id: message.task_id }
              : m
          )
        )
      }
      return
    }

    if (message.type === 'chat_reply') {
      setMessages((prev) => {
        // 找到对应的 request 并更新状态
        const existingIndex = prev.findIndex(
          (m) => m.request_id === message.request_id && m.role === 'assistant'
        )

        // WS chat_reply 的 content 是 string，包装成 ChatMessageContent
        const msgContent: ChatMessageContent = { type: 'text', text: message.content }

        if (existingIndex >= 0) {
          // 更新现有消息
          const updated = [...prev]
          updated[existingIndex] = {
            ...updated[existingIndex],
            content: msgContent,
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
            content: msgContent,
            request_id: message.request_id,
            task_id: message.task_id,
            reply_type: message.reply_type,
            timestamp: new Date().toISOString(),
            status: message.status === 'completed' ? 'completed' : 'failed',
          },
        ]
      })
      // direct_reply 也可能携带 task_id（supplement 路径）：打标同 request_id 的 user 消息
      if (message.task_id) {
        setMessages((prev) =>
          prev.map((m) =>
            m.request_id === message.request_id && m.role === 'user' && !m.task_id
              ? { ...m, task_id: message.task_id }
              : m
          )
        )
      }
    } else if (message.type === 'chat_error') {
      // 占位气泡退役后无原地收口对象：错误以普通系统提示呈现（toast）。
      // 失败说明（fail-loud）另经 chat_push 作为独立消息到达，与此不重复。
      toast.error(message.error || '消息处理失败')
    } else if (message.type === 'chat_push') {
      // manager 经 send_message 伪 channel 回流的新消息（完整 ChatMessage，含 media）：
      // 直接追加为独立消息（占位气泡已退役，无原地结算对象，UX 对齐 channel）。
      setMessages((prev) => [...prev, { ...message.message, status: 'completed' as const }])
    } else if (message.type === 'chat_message_acked') {
      // 「已接收」标记（protocol-admin §3.20.2）：agent 在人类输入 commit 后经
      // chat_acknowledge 打标并推送。本地时间即可（刷新后经聊天历史读到持久化值）。
      setMessages((prev) =>
        prev.map((m) =>
          m.role === 'user' && !m.acknowledged_at && m.request_id !== undefined
            && message.request_ids.includes(m.request_id)
            ? { ...m, acknowledged_at: new Date().toISOString() }
            : m
        )
      )
    } else if (message.type === 'chat_task_update') {
      // 任务状态/计划变更：upsert 进 taskStatuses（终态也保留供图标显示 ✓/✗）
      upsertTaskStatus(message.task)
    } else if (message.type === 'chat_message_tagged') {
      // Admin 回填：把对应 message_id 的消息打上 task_id
      const { message_id, task_id } = message
      setMessages((prev) =>
        prev.map((m) =>
          m.message_id === message_id ? { ...m, task_id } : m
        )
      )
      // 如果 taskStatuses 还没有该 task_id 的快照，拉一次
      setTaskStatuses((cur) => {
        if (!cur.has(task_id)) {
          chatService.getTaskSnapshot(task_id).then((snap) => {
            if (snap) upsertTaskStatus(snap)
          }).catch(() => {/* 静默忽略 */})
        }
        return cur
      })
    } else if (message.type === 'chat_message_deleted') {
      // 单条消息删除（DELETE /api/chat/messages/:id 成功后推送）
      const { message_id } = message
      setMessages((prev) => prev.filter((m) => m.message_id !== message_id))
    }
  }

  // 添加附件（过滤超过 25MB 的文件）
  // useCallback([]) 保证引用稳定：toast/setAttachments/objectUrlsRef 均是稳定引用，
  // 可安全在 document 级 paste 监听中直接使用，不会捕获到过期闭包
  const addFiles = useCallback((incoming: FileList | File[]) => {
    const list = Array.from(incoming)
    const valid = list.filter((f) => f.size <= 25 * 1024 * 1024)
    if (valid.length < list.length) {
      toast.warning(`${list.length - valid.length} 个文件超过 25MB 已忽略`)
    }
    // 生成 objectURL 用于预览缩略图
    valid.forEach((f) => {
      if (!objectUrlsRef.current.has(f.name + f.lastModified)) {
        objectUrlsRef.current.set(f.name + f.lastModified, URL.createObjectURL(f))
      }
    })
    setAttachments((prev) => [...prev, ...valid])
  }, [])

  // 移除单个附件（同名同时间戳文件可能共享 objectURL，仅在无其他引用时 revoke）
  const removeAttachment = (index: number) => {
    setAttachments((prev) => {
      const removed = prev[index]
      const key = removed.name + removed.lastModified
      const stillUsed = prev.some((f, i) => i !== index && f.name + f.lastModified === key)
      const url = objectUrlsRef.current.get(key)
      if (url && !stillUsed) {
        URL.revokeObjectURL(url)
        objectUrlsRef.current.delete(key)
      }
      return prev.filter((_, i) => i !== index)
    })
  }

  // 释放一批附件的预览 objectURL（发送完成后调用，防内存泄漏）
  const releasePreviewUrls = (files: File[]) => {
    for (const f of files) {
      const key = f.name + f.lastModified
      const url = objectUrlsRef.current.get(key)
      if (url) {
        URL.revokeObjectURL(url)
        objectUrlsRef.current.delete(key)
      }
    }
  }

  // 获取文件预览 objectURL（图片用）
  const getObjectUrl = (file: File): string => {
    const key = file.name + file.lastModified
    if (!objectUrlsRef.current.has(key)) {
      objectUrlsRef.current.set(key, URL.createObjectURL(file))
    }
    return objectUrlsRef.current.get(key)!
  }

  // 整页粘贴附件：注册到 document，无需先 focus 输入框
  // addFiles 已是 useCallback([]) 稳定引用，闭包安全
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.clipboardData && e.clipboardData.files.length > 0) {
        e.preventDefault()
        addFiles(e.clipboardData.files)
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [addFiles])

  // 发送消息（附件路径失败时保留 quote，与保留 input/attachments 同语义）
  const handleSend = async () => {
    const content = input.trim()
    // 只有 quote 而无正文/附件时不能发送
    if ((!content && attachments.length === 0) || connectionStatus !== 'connected') return
    if (isSending) return

    setIsSending(true)
    try {
      if (attachments.length > 0) {
        // 带附件走 HTTP multipart。
        // 清空动作放在发送成功之后：失败时保留 input/attachments/quote 让用户直接重试
        const files = attachments
        const composed = composeWithQuote(content)
        const { message } = await chatService.sendMessageWithAttachments(composed, files)
        setAttachments([])
        setInput('')
        setQuote(null)
        releasePreviewUrls(files)
        // 只追加用户消息；回复由 chat_push 作为独立消息到达（占位气泡已退役）。
        setMessages((prev) => [
          ...prev,
          { ...message, status: 'sent' as const },
        ])
      } else {
        // 既有 WS 纯文本路径（入口已保证 content 非空）
        const composed = composeWithQuote(content)
        const request_id = chatService.sendMessage(composed)

        // 添加用户消息（内容含引用块前缀）；回复由 chat_push 作为独立消息到达
        const userMessage: MessageState = {
          message_id: `msg_${Date.now()}`,
          role: 'user',
          content: { type: 'text', text: composed },
          request_id,
          timestamp: new Date().toISOString(),
          status: 'sent',
        }

        setMessages((prev) => [...prev, userMessage])
        setInput('')
        setQuote(null)
      }

      inputRef.current?.focus()
    } catch (error) {
      console.error('Failed to send message:', error)
      toast.error('发送失败，请重试')
    } finally {
      setIsSending(false)
    }
  }

  // 处理键盘事件（两种发送模式，见 sendMode）
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setQuote(null)
      return
    }
    if (e.key !== 'Enter') return
    const wantSend = sendMode === 'enter'
      ? !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey  // 模式1：Enter 发送，Shift+Enter 换行
      : e.ctrlKey || e.altKey                                  // 模式2：Enter 换行，Ctrl/Alt+Enter 发送
    if (wantSend) {
      e.preventDefault()
      handleSend()
    }
    // 不发送时放行，textarea 原生插入换行（模式2 的 Ctrl/Alt+Enter 原生不换行，无需处理）
  }

  const toggleSendMode = () => {
    const next = sendMode === 'enter' ? 'mod-enter' : 'enter'
    setSendMode(next)
    localStorage.setItem('chat_send_mode', next)
    inputRef.current?.focus()
  }

  // 重连
  const handleReconnect = () => {
    chatService.connect()
  }

  /** 引用整条消息（由右键菜单中的「引用」项触发） */
  const handleQuoteMessage = useCallback((m: MessageState) => {
    setQuote({ role: m.role, text: m.content.text ?? '' })
  }, [])

  /**
   * 右键菜单打开回调（useCallback([]) 保证稳定引用不破坏 ChatMessageItem memo）
   * 依赖数组为空：setContextMenu 是 stable dispatch，不需要列入
   */
  const handleContextMenu = useCallback((e: React.MouseEvent, m: MessageState) => {
    setContextMenu({ x: e.clientX, y: e.clientY, message: m })
  }, [])

  /** 选中文本后触发浮动「引用」按钮（消息容器 onMouseUp） */
  const handleSelectionQuote = (e: React.MouseEvent) => {
    const sel = window.getSelection()
    const text = sel?.toString().trim()
    if (!text) {
      setSelectionQuote(null)
      return
    }
    // 找选区起点所属气泡的角色（气泡外层带 data-msg-role 属性）
    let node: Node | null = sel!.anchorNode
    let role: 'user' | 'assistant' = 'assistant'
    while (node) {
      if (node instanceof HTMLElement && node.dataset.msgRole) {
        role = node.dataset.msgRole as 'user' | 'assistant'
        break
      }
      node = node.parentNode
    }
    // 钳制到视口内：选区贴近顶部/右缘时按钮不可飞出屏幕
    setSelectionQuote({
      x: Math.min(e.clientX, window.innerWidth - 88),
      y: Math.max(8, e.clientY - 40),
      role,
      text,
    })
  }

  /** 将正文与引用胶囊拼为 markdown 引用块格式 */
  const composeWithQuote = (text: string): string => {
    if (!quote) return text
    const quoted = quote.text.split('\n').map((l) => `> ${l}`).join('\n')
    return `> 引用${quote.role === 'user' ? '我' : ' Crabot'}的消息：\n${quoted}\n\n${text}`
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

  return (
    <MainLayout>
      <div
        style={{
          // 扣掉 Header 高度 + MainLayout main 的上下 padding（4rem），
          // 让本页刚好占满剩余视口——窗口不滚动，滚动权交给内部消息容器
          height: 'calc(100vh - var(--header-height) - 4rem)',
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>聊天</h1>
            <button
              onClick={() => setShowSettings(true)}
              title="聊天媒体设置"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '1.1rem', color: 'var(--text-secondary)' }}
            >
              ⚙
            </button>
            <button
              onClick={() => setShowClearConfirm(true)}
              title="清空聊天记录"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-secondary)', padding: '0.25rem 0.5rem' }}
            >
              清空
            </button>
          </div>
          {renderConnectionStatus()}
        </div>

        {/* 消息区域 */}
        <div
          // minHeight: 0 是关键：flex 子项默认 min-height:auto，内容多时会撑破
          // 父级固定高度让整个窗口滚动；钳制后内层 overflowY:auto 容器才是滚动者
          style={{ flex: 1, minHeight: 0, position: 'relative', marginBottom: '1rem' }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files) }}
        >
          <div
            ref={messagesContainerRef}
            onScroll={handleScroll}
            onMouseUp={handleSelectionQuote}
            onMouseDown={(e) => {
              // 若点击不在浮动引用按钮上，清空选中引用浮层
              const target = e.target as HTMLElement
              if (!target.closest('[data-selection-quote-btn]')) {
                setSelectionQuote(null)
              }
            }}
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
              {messages.map((message, i) => {
                const prev = messages[i - 1]
                const showDate = !prev || !sameLocalDay(prev.timestamp, message.timestamp)
                return (
                  <React.Fragment key={message.message_id}>
                    {showDate && (
                      <div style={{ textAlign: 'center', margin: '1rem 0' }}>
                        <span
                          style={{
                            fontSize: '0.78rem',
                            color: 'var(--text-secondary)',
                            backgroundColor: 'var(--surface)',
                            border: '1px solid var(--border)',
                            borderRadius: '10px',
                            padding: '0.2rem 0.75rem',
                          }}
                        >
                          {formatDateLabel(message.timestamp)}
                        </span>
                      </div>
                    )}
                    <ChatMessageItem
                      message={message}
                      onContextMenu={handleContextMenu}
                      taskSnapshot={message.task_id ? taskStatuses.get(message.task_id) : undefined}
                      highlighted={contextMenu?.message.message_id === message.message_id}
                    />
                  </React.Fragment>
                )
              })}
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

        {/* 选中文本浮动「引用」按钮（fixed 定位，出现在鼠标松开位置上方） */}
        {selectionQuote && (
          <button
            data-selection-quote-btn="1"
            onMouseDown={(e) => {
              // 使用 mousedown 避免先于 mouseup 清空选区
              e.preventDefault()
              setQuote({ role: selectionQuote.role, text: selectionQuote.text })
              setSelectionQuote(null)
              inputRef.current?.focus()
            }}
            style={{
              position: 'fixed',
              left: selectionQuote.x,
              top: selectionQuote.y,
              zIndex: 1100,
              padding: '0.3rem 0.75rem',
              fontSize: '0.8rem',
              backgroundColor: 'var(--primary)',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
              userSelect: 'none',
            }}
          >
            引用
          </button>
        )}

        {/* 引用胶囊（输入区上方，可取消） */}
        {quote && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.4rem 0.75rem',
              marginBottom: '0.5rem',
              borderLeft: '3px solid var(--primary)',
              backgroundColor: 'var(--surface)',
              borderRadius: '6px',
              fontSize: '0.82rem',
              color: 'var(--text-secondary)',
            }}
          >
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              引用{quote.role === 'user' ? '我' : ' Crabot'}：{quote.text.slice(0, 80)}
            </span>
            <button
              onClick={() => setQuote(null)}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', flexShrink: 0 }}
            >
              ✕
            </button>
          </div>
        )}

        {/* 附件预览条 */}
        {attachments.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.5rem',
              padding: '0.5rem 1rem',
              marginBottom: '0.5rem',
              backgroundColor: 'var(--bg-secondary)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
            }}
          >
            {attachments.map((file, index) => (
              <div
                key={index}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.3rem 0.6rem',
                  borderRadius: '6px',
                  backgroundColor: 'var(--bg-primary)',
                  border: '1px solid var(--border)',
                  fontSize: '0.85rem',
                }}
              >
                {file.type.startsWith('image/') ? (
                  <img
                    src={getObjectUrl(file)}
                    alt={file.name}
                    style={{ width: '32px', height: '32px', objectFit: 'cover', borderRadius: '4px' }}
                  />
                ) : (
                  <span>📎</span>
                )}
                <span style={{ maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {file.name}
                </span>
                <button
                  onClick={() => removeAttachment(index)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--text-secondary)', fontSize: '0.9rem', padding: '0 2px',
                  }}
                  title="移除附件"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

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
          {/* 隐藏的文件选择 input */}
          <input
            type="file"
            multiple
            ref={fileInputRef}
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              // 重置 value：否则再次选择同一文件不触发 onChange
              e.target.value = ''
            }}
            style={{ display: 'none' }}
          />
          {/* 附件按钮 */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={connectionStatus !== 'connected'}
            title="添加附件"
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '1.1rem',
              padding: '0.5rem',
              color: 'var(--text-secondary)',
              flexShrink: 0,
            }}
          >
            📎
          </button>
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value)
              // 自适应高度（上限 ~6 行）
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
            }}
            onKeyDown={handleKeyDown}
            placeholder={connectionStatus === 'connected' ? '输入消息，可粘贴或拖拽附件...' : '等待连接...'}
            disabled={connectionStatus !== 'connected'}
            className="input"
            style={{ flex: 1, resize: 'none', overflowY: 'auto', maxHeight: '160px', lineHeight: '1.5', fontFamily: 'inherit' }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', alignItems: 'stretch' }}>
            <button
              onClick={handleSend}
              disabled={(!input.trim() && attachments.length === 0) || connectionStatus !== 'connected' || isSending}
              className="btn btn-primary"
              style={{ padding: '0.5rem 1.5rem' }}
            >
              {isSending ? '发送中...' : '发送'}
            </button>
            <button
              onClick={toggleSendMode}
              title={sendMode === 'enter'
                ? '当前：Enter 发送，Shift+Enter 换行（点击切换）'
                : '当前：Enter 换行，Ctrl/Alt+Enter 发送（点击切换）'}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                fontSize: '0.7rem', color: 'var(--text-secondary)', padding: 0, whiteSpace: 'nowrap',
              }}
            >
              {sendMode === 'enter' ? 'Enter 发送 ⇄' : 'Ctrl+Enter 发送 ⇄'}
            </button>
          </div>
        </div>
      </div>

      {/* 聊天媒体设置弹窗 */}
      {showSettings && <ChatSettingsModal onClose={() => setShowSettings(false)} />}

      {/* 消息右键菜单 */}
      {contextMenu && (
        <MessageContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onQuote={() => {
            handleQuoteMessage(contextMenu.message)
            inputRef.current?.focus()
          }}
          onCopy={() => {
            navigator.clipboard.writeText(contextMenu.message.content.text ?? '').then(() => {
              toast.success('已复制')
            }).catch(() => {
              toast.error('复制失败')
            })
          }}
          onDelete={() => {
            const msg = contextMenu.message
            // 乐观本地移除
            setMessages((prev) => prev.filter((m) => m.message_id !== msg.message_id))
            // 本地占位消息（msg_ 前缀）从未落服务端，无需调接口（否则 404 误报"删除失败"）；
            // 服务端消息调接口删，成功后还会推 chat_message_deleted，前端 filter 为幂等
            if (!msg.message_id.startsWith('msg_')) {
              chatService.deleteMessage(msg.message_id).catch(() => {
                toast.error('删除失败')
              })
            }
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* 清空聊天历史二次确认 */}
      <ConfirmModal
        open={showClearConfirm}
        title="清空聊天记录"
        message="确定清空全部聊天记录吗？此操作不可撤销。"
        confirmText="清空"
        confirmVariant="danger"
        loading={isClearingMessages}
        onCancel={() => setShowClearConfirm(false)}
        onConfirm={async () => {
          setIsClearingMessages(true)
          try {
            await chatService.clearMessages()
            setMessages([])
            setTaskStatuses(new Map())
            setShowClearConfirm(false)
            toast.success('已清空')
          } catch {
            toast.error('清空失败')
          } finally {
            setIsClearingMessages(false)
          }
        }}
      />
    </MainLayout>
  )
}
