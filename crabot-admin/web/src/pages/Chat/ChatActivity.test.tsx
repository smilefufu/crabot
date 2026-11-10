import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatActivity, type PendingChatRequest } from './ChatActivity'

describe('聊天等待提示的展示期限', () => {
  afterEach(() => { vi.useRealTimers() })

  it('60 秒后改为静态等待，重连不重置期限，卸载清理计时器', () => {
    vi.useFakeTimers()
    const requests = new Map<string, PendingChatRequest>([['first', { phase: 'waiting', sentAt: Date.now() }]])
    const { rerender, unmount } = render(<ChatActivity requests={requests} connectionStatus="connected" />)
    expect(screen.getByRole('status')).toHaveTextContent('Crabot 思考中…')
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByRole('status')).toHaveTextContent('仍在等待回复')
    expect(document.querySelector('[data-thinking="true"]')).toBeNull()
    rerender(<ChatActivity requests={requests} connectionStatus="disconnected" />)
    rerender(<ChatActivity requests={requests} connectionStatus="connected" />)
    expect(screen.getByRole('status')).toHaveTextContent('仍在等待回复')
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('后发请求独立计时，移除后不延长旧请求动画', () => {
    vi.useFakeTimers()
    const first: PendingChatRequest = { phase: 'waiting', sentAt: Date.now() }
    const { rerender, unmount } = render(<ChatActivity requests={new Map([['first', first]])} connectionStatus="connected" />)
    act(() => { vi.advanceTimersByTime(30_000) })
    const second: PendingChatRequest = { phase: 'waiting', sentAt: Date.now() }
    rerender(<ChatActivity requests={new Map([['first', first], ['second', second]])} connectionStatus="connected" />)
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(screen.getByRole('status')).toHaveTextContent('Crabot 思考中…')
    rerender(<ChatActivity requests={new Map([['first', first]])} connectionStatus="connected" />)
    expect(screen.getByRole('status')).toHaveTextContent('仍在等待回复')
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('退出页面时取消尚未到期的动画计时器', () => {
    vi.useFakeTimers()
    const { unmount } = render(<ChatActivity requests={new Map([['pending', { phase: 'waiting', sentAt: Date.now() }]])} connectionStatus="connected" />)
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
