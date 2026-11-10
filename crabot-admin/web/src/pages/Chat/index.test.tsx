/**
 * Master Chat 无占位气泡的追加流 + 「已接收」标记（protocol-admin §3.20.2）。
 *
 * 占位退役后：发送只本地追加用户消息；回复（chat_push / chat_reply 历史兼容）一律作为
 * 独立消息追加；chat_error 走 toast 提示；chat_message_acked 在用户消息上渲染 ✓ 标记。
 */
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Chat } from './index'
import type { ChatMessage, ChatServerMessage, ConnectionStatus } from '../../types/chat'
import { ClientError } from 'crabot-client'
import { setServerScope } from '../../services/server-state'

const loadHistory = vi.fn()
const sendMessage = vi.fn()
const sendMessageWithAttachments = vi.fn()
const clearMessages = vi.fn()
const getTaskSnapshot = vi.fn()
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
let messageHandler: ((m: ChatServerMessage) => void) | null = null
let statusHandler: ((s: ConnectionStatus) => void) | null = null
let persistedMessages: ChatMessage[] = []
let nextRequestId = 'keyboard-request'
vi.mock('crabot-client', async () => ({
  ...await vi.importActual<typeof import('crabot-client')>('crabot-client'),
  createRequestId: () => nextRequestId,
}))

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
    onStatusChange: (handler: (s: ConnectionStatus) => void) => {
      statusHandler = handler
      return () => { statusHandler = null }
    },
    onMessage: (handler: (m: ChatServerMessage) => void) => {
      messageHandler = handler
      return () => { messageHandler = null }
    },
    loadHistory: (...args: unknown[]) => loadHistory(...args),
    sendMessage: (...args: unknown[]) => sendMessage(...args),
    sendMessageWithAttachments: (...args: unknown[]) => sendMessageWithAttachments(...args),
    getTaskSnapshot: (...args: unknown[]) => getTaskSnapshot(...args),
    deleteMessage: vi.fn(),
    clearMessages: (...args: unknown[]) => clearMessages(...args),
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
  URL.createObjectURL = vi.fn(() => 'blob:test')
  URL.revokeObjectURL = vi.fn()
})

/** 渲染并发送一条消息，返回它的 request_id */
async function renderAndSend(requestId: string): Promise<void> {
  nextRequestId = requestId
  sendMessage.mockImplementation(async (text: string, id: string) => {
    const message: ChatMessage = { message_id: `srv-user-${id}`, role: 'user', content: { type: 'text', text }, request_id: id, timestamp: new Date().toISOString() }
    persistedMessages.push(message)
    return { request_id: id, message }
  })
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
  if (message.type === 'chat_push') persistedMessages.push(message.message)
  if (message.type === 'chat_message_acked') persistedMessages = persistedMessages.map(item => message.request_ids.includes(item.request_id ?? '') ? { ...item, acknowledged_at: new Date().toISOString() } : item)
  await act(async () => {
    await messageHandler!(message)
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
    persistedMessages = []
    loadHistory.mockImplementation(async (limit = 30, before?: string) => [...persistedMessages].filter(message => !before || message.timestamp < before).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit))
    getTaskSnapshot.mockResolvedValue(null)
    clearMessages.mockResolvedValue(undefined)
  })

  it('发送后显示临时思考提示，不添加 assistant 占位消息', async () => {
    await renderAndSend('req-1')

    expect(screen.getByText('帮我看下这个')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Crabot 思考中…')
    expect(document.querySelector('[data-msg-role="assistant"]')).toBeNull()
  })

  it('HTTP 发送结果未知时保留草稿，原样重试复用 request_id 且只显示一个服务端 UUID', async () => {
    sendMessage.mockRejectedValueOnce(new ClientError('unreachable', 'response lost'))
    await renderAndSend('req-retry')
    expect(screen.getByRole('textbox')).toHaveValue('帮我看下这个')
    expect(toastMocks.error).toHaveBeenCalledWith(expect.stringContaining('发送结果尚未确认'))
    await act(async () => { fireEvent.click(screen.getByText('发送')) })
    expect(sendMessage.mock.calls.map(call => call[1])).toEqual(['req-retry', 'req-retry'])
    expect(persistedMessages).toHaveLength(1)
    expect(screen.getAllByText('帮我看下这个')).toHaveLength(1)
  })

  it('提交期间继续编辑的新草稿不会被较早的 HTTP 成功响应清空', async () => {
    let resolve!: (value: unknown) => void
    sendMessage.mockImplementation(() => new Promise(done => { resolve = done }))
    render(<MemoryRouter><Chat /></MemoryRouter>)
    await waitFor(() => expect(loadHistory).toHaveBeenCalled())
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'first' } })
    fireEvent.click(screen.getByText('发送'))
    fireEvent.change(input, { target: { value: 'new draft' } })
    const message: ChatMessage = { message_id: 'first-http', role: 'user', content: { type: 'text', text: 'first' }, timestamp: new Date().toISOString() }
    persistedMessages.push(message)
    await act(async () => { resolve({ message, request_id: 'first' }) })
    expect(input).toHaveValue('new draft')
    expect(screen.getByText('first')).toBeInTheDocument()
  })

  it('实例切换后忽略旧实例的迟到发送结果并保留草稿', async () => {
    let resolve!: (value: unknown) => void
    sendMessage.mockImplementation(() => new Promise(done => { resolve = done }))
    render(<MemoryRouter><Chat /></MemoryRouter>)
    await waitFor(() => expect(loadHistory).toHaveBeenCalled())
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'old instance draft' } })
    fireEvent.click(screen.getByText('发送'))
    await act(async () => { setServerScope('replacement-instance') })
    await act(async () => { resolve({ message: {
      message_id: 'late-old-instance', role: 'user', content: { type: 'text', text: 'old instance result' }, timestamp: new Date().toISOString(),
    } }) })
    expect(input).toHaveValue('old instance draft')
    expect(screen.queryByText('old instance result')).not.toBeInTheDocument()
    await act(async () => { setServerScope('browser') })
  })

  it('chat_push 回复直接追加为独立消息', async () => {
    await renderAndSend('req-2')
    await push(assistantPush('看完了，结论是这样', 'req-2'))

    expect(screen.getByText('帮我看下这个')).toBeInTheDocument()
    expect(screen.getByText('看完了，结论是这样')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
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
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('chat_error 以 toast 提示，不改写消息流', async () => {
    await renderAndSend('req-5')
    await push({ type: 'chat_error', request_id: 'req-5', error: '系统暂时不可用，请稍后重试' })

    expect(toastMocks.error).toHaveBeenCalledWith('系统暂时不可用，请稍后重试')
    expect(screen.getByText('帮我看下这个')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('chat_message_acked 后用户消息出现已接收标记；发送后先无标记', async () => {
    await renderAndSend('req-6')

    // 未打标：无 ✓ 标记
    expect(screen.queryByTitle(/已接收/)).not.toBeInTheDocument()

    await push({ type: 'chat_message_acked', request_ids: ['req-6'] })

    expect(screen.getByTitle(/已接收/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Crabot 思考中…')
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
      { ...persistedMessages.find(message => message.request_id === 'req-8')!, acknowledged_at: new Date().toISOString() },
    ])
    await act(async () => { statusHandler!('connected') })

    expect(screen.getByText('断连前的回复')).toBeInTheDocument()
    expect(screen.getByTitle(/已接收/)).toBeInTheDocument()
    // 已知 UUID 被快照更新标记，不重复显示。
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

  it('回复先到、重连补 user 消息：按时间戳归位，提问不沉到回复后面', async () => {
    await renderAndSend('req-10')
    // 回复经 chat_push 先到（服务端 UUID 进入已知集合）
    await push(assistantPush('回复先到了', 'req-10'))
    // 重连拉历史：回复已 known 被去重跳过，只剩 user 消息进 fresh——
    // 若 concat 队尾，提问会渲染到回复后面（review 指出的必现顺序错乱）
    loadHistory.mockResolvedValue([
      { message_id: 'srv_回复先到了', role: 'assistant', content: { type: 'text', text: '回复先到了' }, request_id: 'req-10', timestamp: new Date().toISOString() },
      { ...persistedMessages.find(message => message.request_id === 'req-10')!, acknowledged_at: new Date().toISOString() },
    ])
    await act(async () => { statusHandler!('connected') })

    expect(screen.getAllByText('帮我看下这个')).toHaveLength(1)
    expect(screen.getAllByText('回复先到了')).toHaveLength(1)
    // user 消息必须出现在回复之前（DOM 顺序）
    const user = screen.getByText('帮我看下这个')
    const reply = screen.getByText('回复先到了')
    expect(user.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('主动推送不收起等待，多请求乱序回复只收起显式关联的请求', async () => {
    await renderAndSend('req-first')
    nextRequestId = 'req-second'
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '还有另一件事' } })
    await act(async () => { fireEvent.click(screen.getByText('发送')) })
    await push(assistantPush('主动提醒'))
    await push(assistantPush('第二件事办好了', 'req-second'))
    expect(screen.getByRole('status')).toHaveTextContent('Crabot 思考中…')
    await push(assistantPush('第一件事办好了', 'req-first'))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('一次回复关联多个 request_ids 时全部收起，数组优先于历史单 ID', async () => {
    await renderAndSend('req-batch-1')
    nextRequestId = 'req-batch-2'
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '第二条' } })
    await act(async () => { fireEvent.click(screen.getByText('发送')) })
    const reply = assistantPush('统一答复', 'req-unrelated')
    if (reply.type !== 'chat_push') throw new Error('Expected chat_push')
    reply.message.request_ids = ['req-batch-1', 'req-batch-2']
    await push(reply)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('断连切换为静态提示，重连通过历史显式关联收起等待', async () => {
    await renderAndSend('req-disconnect')
    await act(async () => { statusHandler!('disconnected') })
    expect(screen.getByRole('status')).toHaveTextContent('连接中断，回复状态暂无法确认')
    expect(document.querySelector('[data-thinking="true"]')).toBeNull()
    const reply = assistantPush('断连期间的答复', 'req-disconnect')
    if (reply.type !== 'chat_push') throw new Error('Expected chat_push')
    persistedMessages.push(reply.message)
    await act(async () => { statusHandler!('connected') })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('无归属错误改为静态未知状态，不猜测结算；对应回复仍可收起', async () => {
    await renderAndSend('req-unknown')
    await push({ type: 'chat_error', error: '连接异常' })
    expect(screen.getByRole('status')).toHaveTextContent('回复状态暂无法确认')
    expect(document.querySelector('[data-thinking="true"]')).toBeNull()
    await push(assistantPush('迟到答复', 'req-unknown'))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('附件上传期间立即反馈，回复先于 HTTP 返回时不重新显示思考提示', async () => {
    let resolve!: (value: unknown) => void
    sendMessageWithAttachments.mockImplementation(() => new Promise(done => { resolve = done }))
    nextRequestId = 'req-upload'
    render(<MemoryRouter><Chat /></MemoryRouter>)
    await waitFor(() => expect(loadHistory).toHaveBeenCalled())
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(['hello'], 'test.txt', { type: 'text/plain' })] },
    })
    fireEvent.click(screen.getByText('发送'))
    expect(screen.getByRole('status')).toHaveTextContent('正在发送…')
    expect(screen.queryByText('Crabot 思考中…')).not.toBeInTheDocument()
    await push(assistantPush('文件收到了', 'req-upload'))
    await act(async () => { resolve({ message: {
      message_id: 'upload-user', role: 'user', content: { type: 'file', text: '' }, request_id: 'req-upload', timestamp: new Date().toISOString(),
    } }) })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('发送失败不留下动态提示并保留草稿', async () => {
    sendMessage.mockRejectedValueOnce(new Error('rejected'))
    await renderAndSend('req-rejected')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('帮我看下这个')
    expect(toastMocks.error).toHaveBeenCalledWith(expect.stringContaining('发送失败'))
  })

  it('首次加载历史中的未回复消息不恢复思考提示', async () => {
    persistedMessages.push({ message_id: 'old-user', role: 'user', content: { type: 'text', text: '旧消息' }, request_id: 'old-request', timestamp: new Date().toISOString() })
    render(<MemoryRouter><Chat /></MemoryRouter>)
    await screen.findByText('旧消息')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('其他请求的错误不误收起等待，删除当前用户消息后收起', async () => {
    await renderAndSend('req-delete')
    await push({ type: 'chat_error', request_id: 'req-other', error: '别的请求失败' })
    expect(screen.getByRole('status')).toHaveTextContent('Crabot 思考中…')
    persistedMessages = []
    await push({ type: 'chat_message_deleted', message_id: 'srv-user-req-delete' })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('清空失败保留等待提示，清空成功才收起', async () => {
    await renderAndSend('req-clear')
    clearMessages.mockRejectedValueOnce(new Error('clear failed'))
    fireEvent.click(screen.getByTitle('清空聊天记录'))
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '清空' })) })
    expect(screen.getByRole('status')).toHaveTextContent('Crabot 思考中…')
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '清空' })) })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('聊天发送快捷键', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    loadHistory.mockResolvedValue([])
    getTaskSnapshot.mockResolvedValue(null)
    sendMessage.mockImplementation(async (text: string) => ({ request_id: 'keyboard-request', message: {
      message_id: 'keyboard-message', role: 'user', content: { type: 'text', text }, request_id: 'keyboard-request', timestamp: new Date().toISOString(),
    } }))
  })

  async function composer(platform = 'Win32', modified = false) {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue(platform)
    render(<MemoryRouter><Chat /></MemoryRouter>)
    await waitFor(() => expect(loadHistory).toHaveBeenCalled())
    if (modified) fireEvent.click(screen.getByText('Enter 发送 ⇄'))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'hello' } })
    return input
  }

  it.each([
    ['Win32', { altKey: true }, 'Alt'],
    ['MacIntel', { metaKey: true }, 'Cmd'],
  ])('%s 的组合发送键与提示一致', async (platform, modifiers, label) => {
    const input = await composer(platform, true)
    expect(screen.getByText(`${label}+Enter 发送 ⇄`)).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(sendMessage).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter', ...modifiers })
    expect(sendMessage).toHaveBeenCalledOnce()
    expect(localStorage.getItem('chat_send_mode')).toBe('mod-enter')
  })

  it('Enter 模式允许 Shift+Enter 换行，普通 Enter 发送', async () => {
    const input = await composer()
    expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true)
    expect(sendMessage).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(sendMessage).toHaveBeenCalledOnce()
  })

  it.each([false, true])('组合输入中不能发送（组合发送模式=%s）', async (modified) => {
    const input = await composer('MacIntel', modified)
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter', metaKey: modified })
    expect(sendMessage).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    // Safari 上屏 Enter 可能已结束 composition，但仍带 keyCode 229。
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, metaKey: modified })
    expect(sendMessage).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, metaKey: modified })
    expect(sendMessage).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter', metaKey: modified })
    expect(sendMessage).toHaveBeenCalledOnce()
  })
})
