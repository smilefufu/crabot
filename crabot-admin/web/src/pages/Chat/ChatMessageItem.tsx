/**
 * 单条聊天消息气泡（React.memo：函数式 setMessages 保持未变更消息的对象引用，
 * memo 后历史消息不随列表更新重渲染，ReactMarkdown 不重复解析）
 *
 * memo 稳定性说明：
 * - onContextMenu 由 index.tsx useCallback 保证引用稳定（依赖数组为 []）
 * - taskSnapshot 仅在该任务有新推送时通过 new Map + entry 替换更新（upsert 只替换命中 entry），
 *   其余消息的 taskSnapshot 引用保持不变，memo 浅比较不触发重渲染
 */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { chatService } from '../../services/chat'
import { MessageMedia } from './MessageMedia'
import { TaskStatusIcon } from './TaskStatusIcon'
import type { ChatMessage, ChatTaskSnapshot } from '../../types/chat'

/** 消息状态（从 index.tsx 迁入，UI 层扩展字段） */
export interface MessageState extends ChatMessage {
  status?: 'sending' | 'sent' | 'completed' | 'failed'
  reply_type?: 'direct_reply' | 'task_created' | 'task_completed' | 'task_failed'
  error?: string
}

interface ChatMessageItemProps {
  message: MessageState
  /**
   * 右键菜单回调（含 e.clientX/Y 用于菜单定位）；useCallback([], []) 保证稳定引用，不破坏 memo。
   * 旧 onQuote 拆分为菜单三项之一（引用），由父组件在菜单关闭回调里调用。
   */
  onContextMenu?: (e: React.MouseEvent, m: MessageState) => void
  /** 消息关联任务的快照（来自 index.tsx 的 taskStatuses Map）；引用仅在该任务更新时变化 */
  taskSnapshot?: ChatTaskSnapshot
  /** 当前被右键菜单选中（高亮显示）；仅命中的那条传 true，memo 浅比较只影响该条 */
  highlighted?: boolean
}

export const ChatMessageItem = React.memo(function ChatMessageItem({ message, onContextMenu, taskSnapshot, highlighted }: ChatMessageItemProps) {
  const navigate = useNavigate()
  const isUser = message.role === 'user'

  // task_created 消息（含历史存量）渲染为居中单行系统提示样式，不挂右键引用、不挂任务图标
  if (message.task_id && message.content.text?.startsWith('已创建任务')) {
    return (
      <div style={{ textAlign: 'center', margin: '0.75rem 0' }}>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          ⚙ {message.content.text}
          <a
            onClick={(e) => { e.preventDefault(); navigate(`/traces?task_id=${encodeURIComponent(message.task_id!)}`) }}
            href="#"
            style={{ color: 'var(--primary)', marginLeft: '0.5rem', textDecoration: 'none' }}
          >
            详情 →
          </a>
        </span>
      </div>
    )
  }

  // reply_type 对应的提示信息
  const getReplyTypeHint = () => {
    // task_created 由系统提示行承载，不出提示文字
    if (message.reply_type !== 'task_completed' && message.reply_type !== 'task_failed') return null

    const hints = {
      task_completed: { text: '✓ 任务已完成', color: 'var(--success)' },
      task_failed: { text: '✗ 任务执行失败', color: 'var(--error)' },
    } as const

    const hint = hints[message.reply_type]

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
      data-msg-role={message.role}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, message) } : undefined}
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        alignItems: 'center',
        gap: '0.4rem',
        marginBottom: '1rem',
        // 右键选中：整行背景高亮（不依赖气泡颜色，对自己/Agent 消息都明显）
        // 用负 margin + padding 让背景块向两侧延展，不挤动气泡布局
        padding: '0.4rem 0.75rem',
        margin: '0 -0.75rem 0.6rem',
        borderRadius: '10px',
        backgroundColor: highlighted ? 'var(--surface-elevated, rgba(255,255,255,0.06))' : 'transparent',
        transition: 'background-color 0.12s',
      }}
    >
      {/* user 消息：任务图标在气泡左侧（先渲染图标） */}
      {message.task_id && isUser && (
        <TaskStatusIcon taskId={message.task_id} snapshot={taskSnapshot} />
      )}
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
        {getReplyTypeHint()}
        <div
          className="markdown-content"
          style={{
            wordBreak: 'break-word',
            lineHeight: '1.6',
          }}
        >
          {isUser ? (
            // user 消息：前导 "> " 行（与 composeWithQuote 格式对应）渲染为引用块
            (() => {
              const lines = (message.content.text ?? '').split('\n')
              let quoteEnd = 0
              while (quoteEnd < lines.length && lines[quoteEnd].startsWith('> ')) quoteEnd++
              // 引用块后紧跟的空行也跳过（composeWithQuote 会在引用块后加一行）
              if (quoteEnd > 0 && quoteEnd < lines.length && lines[quoteEnd] === '') quoteEnd++
              const quoteBlock = quoteEnd > 0
                ? lines.slice(0, quoteEnd).join('\n').replace(/^> /gm, '').trimEnd()
                : null
              const bodyText = lines.slice(quoteEnd).join('\n')
              return (
                <>
                  {quoteBlock && (
                    <div
                      style={{
                        borderLeft: '3px solid rgba(255,255,255,0.5)',
                        paddingLeft: '0.6rem',
                        marginBottom: '0.4rem',
                        fontSize: '0.82rem',
                        color: 'rgba(255,255,255,0.75)',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {quoteBlock}
                    </div>
                  )}
                  <div style={{ whiteSpace: 'pre-wrap' }}>{bodyText}</div>
                </>
              )
            })()
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // worker 在正文 markdown 嵌 store 图时统一补 token
                img: ({ src, alt }) => (
                  <img
                    src={typeof src === 'string' ? chatService.mediaSrc(src) : undefined}
                    alt={alt ?? ''}
                    style={{ maxWidth: '100%', borderRadius: '8px' }}
                  />
                ),
                // 链接（含临时页面 URL）在新标签打开，不顶掉当前 Admin 页面
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ),
              }}
            >
              {message.content.text ?? ''}
            </ReactMarkdown>
          )}
        </div>
        {message.content.media && message.content.media.length > 0 && (
          <MessageMedia media={message.content.media} />
        )}
        {message.error && (
          <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--error)' }}>
            {message.error}
          </div>
        )}
      </div>
      {/* 「已接收」标记（user 消息；agent commit 后经 chat_acknowledge 打标，对齐 channel acknowledged reaction） */}
      {isUser && message.acknowledged_at && (
        <span
          title={`已接收 ${new Date(message.acknowledged_at).toLocaleString()}`}
          style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', flexShrink: 0 }}
        >
          ✓
        </span>
      )}
      {/* assistant 消息：任务图标在气泡右侧（后渲染图标） */}
      {message.task_id && !isUser && (
        <TaskStatusIcon taskId={message.task_id} snapshot={taskSnapshot} />
      )}
    </div>
  )
})
