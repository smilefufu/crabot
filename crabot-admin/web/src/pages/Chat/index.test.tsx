/**
 * Master Chat 「处理中」占位气泡的收口路径。
 *
 * cutover 后 manager 正常回复走 send_message → chat_push（完整 ChatMessage，含 media），
 * 前端必须按 request_id 把占位原地替换掉，否则每条回复后都会留一个永远转圈的气泡。
 * 失败兜底（chat_reply）/ chat_error 两条老路径必须照旧。
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
let messageHandler: ((m: ChatServerMessage) => void) | null = null

vi.mock('../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

vi.mock('../../services/chat', () => ({
  chatService: {
    get status() { return 'connected' },
    connect: vi.fn(),
    onStatusChange: () => () => {},
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

/** 渲染并发出一条消息，返回它的 request_id（占位气泡此时已生出） */
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
  // 占位气泡在位
  expect(screen.getByText('思考中...')).toBeInTheDocument()
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

describe('Master Chat 占位气泡收口', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    messageHandler = null
    loadHistory.mockResolvedValue([])
    getTaskSnapshot.mockResolvedValue(null)
  })

  it('正常回复：chat_push 按 request_id 原地替换占位，不残留转圈', async () => {
    await renderAndSend('req-1')
    await push(assistantPush('看完了，结论是这样', 'req-1'))

    expect(screen.queryByText('思考中...')).not.toBeInTheDocument()
    expect(screen.getByText('看完了，结论是这样')).toBeInTheDocument()
  })

  it('manager 主动推送（无 request_id）：纯追加，不吃掉在途占位', async () => {
    await renderAndSend('req-2')
    await push(assistantPush('顺嘴提醒你一句'))

    // 占位照旧转圈（那条请求还没被回答），主动推送作为新气泡追加
    expect(screen.getByText('思考中...')).toBeInTheDocument()
    expect(screen.getByText('顺嘴提醒你一句')).toBeInTheDocument()
  })

  it('request_id 对不上的 chat_push：纯追加，不误伤别人的占位', async () => {
    await renderAndSend('req-3')
    await push(assistantPush('这是另一轮的回复', 'req-other'))

    expect(screen.getByText('思考中...')).toBeInTheDocument()
    expect(screen.getByText('这是另一轮的回复')).toBeInTheDocument()
  })

  it('一轮多条回复：第一条替换占位，后续追加（admin 侧认领即消费，后续不带 request_id）', async () => {
    await renderAndSend('req-4')
    await push(assistantPush('收到，我去办', 'req-4'))
    await push(assistantPush('办好了，结果如下', undefined))

    expect(screen.queryByText('思考中...')).not.toBeInTheDocument()
    expect(screen.getByText('收到，我去办')).toBeInTheDocument()
    expect(screen.getByText('办好了，结果如下')).toBeInTheDocument()
  })

  it('占位已被 chat_push 收口后，同 request_id 再来一条 chat_push：追加而不是覆盖', async () => {
    await renderAndSend('req-5')
    await push(assistantPush('第一条', 'req-5'))
    await push(assistantPush('第二条', 'req-5'))

    expect(screen.queryByText('思考中...')).not.toBeInTheDocument()
    expect(screen.getByText('第一条')).toBeInTheDocument()
    expect(screen.getByText('第二条')).toBeInTheDocument()
  })

  it('失败兜底（chat_reply）路径不受影响：仍按 request_id 收口占位', async () => {
    await renderAndSend('req-6')
    await push({
      type: 'chat_reply',
      request_id: 'req-6',
      content: '我这条消息没处理完，暂时回不了你。',
      reply_type: 'direct_reply',
      status: 'completed',
    })

    expect(screen.queryByText('思考中...')).not.toBeInTheDocument()
    expect(screen.getByText('我这条消息没处理完，暂时回不了你。')).toBeInTheDocument()
  })

  it('chat_error 路径不受影响：占位转 failed 并显示错误', async () => {
    await renderAndSend('req-7')
    await push({ type: 'chat_error', request_id: 'req-7', error: '系统暂时不可用，请稍后重试' })

    expect(screen.queryByText('思考中...')).not.toBeInTheDocument()
    // chat_error 把同 request_id 的 user / assistant 两条都标 failed，错误文案出现不止一处
    expect(screen.getAllByText(/系统暂时不可用，请稍后重试/).length).toBeGreaterThan(0)
  })
})
