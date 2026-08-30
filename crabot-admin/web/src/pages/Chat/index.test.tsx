/**
 * Master Chat 无占位气泡的追加流 + 「已接收」标记（protocol-admin §3.20.2）。
 *
 * 占位退役后：发送只本地追加用户消息；回复（chat_push / chat_reply 历史兼容）一律作为
 * 独立消息追加；chat_error 走 toast 提示；chat_message_acked 在用户消息上渲染 ✓ 标记。
 */
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Chat } from './index'
import type { ChatMessage, ChatServerMessage } from '../../types/chat'

const loadHistory = vi.fn()
const sendMessage = vi.fn()
const getTaskSnapshot = vi.fn()
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
let messageHandler: ((m: ChatServerMessage) => void) | null = null
let statusHandler: ((s: 'connected') => void) | null = null

vi.mock('../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => toastMocks,
}))

vi.mock('../../services/chat', () => ({
  chatService: {
    get status() { return 'connected' },
    connect: vi.fn(),
    onStatusChange: (handler: (s: 'connected') => void) => {
      statusHandler = handler
      return () => { statusHandler = null }
    },
    onMessage: (handler: (m: ChatServerMessage) => void) => {
      messageHandler = handler
      return () => { messageHandler = null }
    },
    loadHistory: (...args: unknown[]) => loadHistory(...args),
    sendMessage: (...args: unknown[]) => sendMessage(...args),
    sendMessageWithAttachments: vi.fn(),
    getTaskSnapshot: (...args: unknown[]) => getTaskSnapshot(...args),
    deleteMessage: vi.fn(),
    clearMessages: vi.fn(),
    mediaSrc: (u: string) => u,
  },
}))

beforeAll(() => {
  // jsdom 缺这两个：组件的顶部哨兵 observer 与自动滚底都会用到
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Element.prototype.scrollIntoView = vi.fn()
})

/** 渲染并发送一条消息，返回它的 request_id */
async function renderAndSend(requestId: string): Promise<void> {
  sendMessage.mockReturnValue(requestId)
  render(
    <MemoryRouter>
      <Chat />
    </MemoryRouter>
  )
  await waitFor(() => expect(loadHistory).toHaveBeenCalled())

  const textarea = screen.getByPlaceholderText('输入消息，可粘贴或拖拽附件...')
  fireEvent.change(textarea, { target: { value: '帮我看下这个' } })
  await act(async () => {
    fireEvent.click(screen.getByText('发送'))
  })
}

/** 把一条服务端推送喂给组件已注册的 handler */
async function push(message: ChatServerMessage): Promise<void> {
  await act(async () => {
    messageHandler!(message)
  })
}

function assistantPush(text: string, requestId?: string): ChatServerMessage {
  const message: ChatMessage = {
    message_id: `srv_${text}`,
    role: 'assistant',
    content: { type: 'text', text },
    ...(requestId !== undefined ? { request_id: requestId } : {}),
    timestamp: new Date().toISOString(),
  }
  return { type: 'chat_push', message }
}

describe('Master Chat 无占位追加流与已接收标记', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    messageHandler = null
    statusHandler = null
    loadHistory.mockResolvedValue([])
    getTaskSnapshot.mockResolvedValue(null)
  })

  it('发送后只显示用户消息，无「思考中」占位', async () => {
    await renderAndSend('req-1')

    expect(screen.getByText('帮我看下这个')).toBeInTheDocument()
    expect(screen.queryByText('思考中...')).not.toBeInTheDocument()
  })

  it('chat_push 回复直接追加为独立消息', async () => {
    await renderAndSend('req-2')
    await push(assistantPush('看完了，结论是这样', 'req-2'))

    expect(screen.getByText('帮我看下这个')).toBeInTheDocument()
    expect(screen.getByText('看完了，结论是这样')).toBeInTheDocument()
  })

  it('一轮多条回复：全部追加，互不覆盖', async () => {
    await renderAndSend('req-3')
    await push(assistantPush('收到，我去办', 'req-3'))
    await push(assistantPush('办好了，结果如下'))

    expect(screen.getByText('收到，我去办')).toBeInTheDocument()
    expect(screen.getByText('办好了，结果如下')).toBeInTheDocument()
  })

  it('chat_reply（历史兼容路径）同样追加为独立消息', async () => {
    await renderAndSend('req-4')
    await push({
      type: 'chat_reply',
      request_id: 'req-4',
      content: '我这条消息没处理完，暂时回不了你。',
      reply_type: 'direct_reply',
      status: 'completed',
    })

    expect(screen.getByText('我这条消息没处理完，暂时回不了你。')).toBeInTheDocument()
  })

  it('chat_error 以 toast 提示，不改写消息流', async () => {
    await renderAndSend('req-5')
    await push({ type: 'chat_error', request_id: 'req-5', error: '系统暂时不可用，请稍后重试' })

    expect(toastMocks.error).toHaveBeenCalledWith('系统暂时不可用，请稍后重试')
    expect(screen.getByText('帮我看下这个')).toBeInTheDocument()
  })

  it('chat_message_acked 后用户消息出现已接收标记；发送后先无标记', async () => {
    await renderAndSend('req-6')

    // 未打标：无 ✓ 标记
    expect(screen.queryByTitle(/已接收/)).not.toBeInTheDocument()

    await push({ type: 'chat_message_acked', request_ids: ['req-6'] })

    expect(screen.getByTitle(/已接收/)).toBeInTheDocument()
  })

  it('chat_message_acked 对不上的 request_id：不误标别人的消息', async () => {
    await renderAndSend('req-7')
    await push({ type: 'chat_message_acked', request_ids: ['req-other'] })

    expect(screen.queryByTitle(/已接收/)).not.toBeInTheDocument()
  })

  it('重连后补齐断连期间的服务端消息：回复追加、✓ 标记经 acknowledged_at 恢复', async () => {
    await renderAndSend('req-8')
    // 断连期间服务端落库（loadHistory 倒序：最新在前）
    loadHistory.mockResolvedValue([
      { message_id: 'srv_reply', role: 'assistant', content: { type: 'text', text: '断连前的回复' }, request_id: 'req-8', timestamp: new Date().toISOString() },
      { message_id: 'srv_user', role: 'user', content: { type: 'text', text: '帮我看下这个' }, request_id: 'req-8', acknowledged_at: new Date().toISOString(), timestamp: new Date().toISOString() },
    ])
    await act(async () => { statusHandler!('connected') })

    expect(screen.getByText('断连前的回复')).toBeInTheDocument()
    expect(screen.getByTitle(/已接收/)).toBeInTheDocument()
    // 本地乐观 user 消息被落库版本取代（同 request_id），不重复显示
    expect(screen.getAllByText('帮我看下这个')).toHaveLength(1)
  })

  it('重连补齐幂等：重复合并已知的消息不重复追加', async () => {
    await renderAndSend('req-9')
    loadHistory.mockResolvedValue([
      { message_id: 'srv_reply9', role: 'assistant', content: { type: 'text', text: '只此一条' }, request_id: 'req-9', timestamp: new Date().toISOString() },
    ])
    await act(async () => { statusHandler!('connected') })
    await act(async () => { statusHandler!('connected') })

    expect(screen.getAllByText('只此一条')).toHaveLength(1)
  })
})
