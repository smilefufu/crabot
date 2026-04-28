import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ProgressDigest } from '../../src/engine/progress-digest'
import type { ProgressDigestConfig, ProgressDigestDeps } from '../../src/engine/progress-digest'
import type { EngineTurnEvent } from '../../src/engine/types'

function makeEvent(overrides: Partial<EngineTurnEvent> = {}): EngineTurnEvent {
  return {
    turnNumber: 1,
    assistantText: '正在处理...',
    toolCalls: [],
    stopReason: 'end_turn',
    ...overrides,
  }
}

function makeToolCall(overrides: Partial<{ id: string; name: string; input: Record<string, unknown>; output: string; isError: boolean }> = {}) {
  return {
    id: 'tool-1',
    name: 'Read',
    input: {},
    output: 'ok',
    isError: false,
    ...overrides,
  }
}

function makeDeps(sendToUser = vi.fn().mockResolvedValue(undefined)): ProgressDigestDeps {
  return {
    sendToUser,
    getChatHistory: async () => [],
  }
}

describe('ProgressDigest flush behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('tool execution error does NOT immediately flush — interval still controls cadence', async () => {
    const sendToUser = vi.fn().mockResolvedValue(undefined)
    const config: ProgressDigestConfig = {
      intervalMs: 1_800_000,
      mode: 'extract',
      isMasterPrivate: true,
    }
    const digest = new ProgressDigest(config, makeDeps(sendToUser))

    digest.ingest(makeEvent({
      assistantText: '尝试编辑',
      toolCalls: [makeToolCall({ name: 'Edit', isError: true, output: 'old_string not found' })],
    }))

    await vi.advanceTimersByTimeAsync(1000)
    expect(sendToUser).not.toHaveBeenCalled()

    digest.dispose()
  })

  it('multiple successive tool errors within interval do not produce multiple digests', async () => {
    const sendToUser = vi.fn().mockResolvedValue(undefined)
    const config: ProgressDigestConfig = {
      intervalMs: 1_800_000,
      mode: 'extract',
      isMasterPrivate: true,
    }
    const digest = new ProgressDigest(config, makeDeps(sendToUser))

    for (let i = 0; i < 5; i++) {
      digest.ingest(makeEvent({
        assistantText: `第 ${i} 次尝试`,
        toolCalls: [makeToolCall({ name: 'Edit', isError: true })],
      }))
      await vi.advanceTimersByTimeAsync(60_000)
    }

    expect(sendToUser).not.toHaveBeenCalled()

    digest.dispose()
  })

  it('ask_human tool call flushes immediately (interactive must be delivered now)', async () => {
    const sendToUser = vi.fn().mockResolvedValue(undefined)
    const config: ProgressDigestConfig = {
      intervalMs: 1_800_000,
      mode: 'extract',
      isMasterPrivate: true,
    }
    const digest = new ProgressDigest(config, makeDeps(sendToUser))

    digest.ingest(makeEvent({
      assistantText: '需要确认',
      toolCalls: [makeToolCall({ name: 'mcp__crabot-worker__ask_human' })],
    }))

    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve()
    expect(sendToUser).toHaveBeenCalledTimes(1)

    digest.dispose()
  })

  it('interval timer fires after intervalMs and flushes accumulated buffer', async () => {
    const sendToUser = vi.fn().mockResolvedValue(undefined)
    const config: ProgressDigestConfig = {
      intervalMs: 1_800_000,
      mode: 'extract',
      isMasterPrivate: true,
    }
    const digest = new ProgressDigest(config, makeDeps(sendToUser))

    digest.ingest(makeEvent({
      assistantText: '执行中',
      toolCalls: [makeToolCall({ name: 'Read', isError: false })],
    }))

    await vi.advanceTimersByTimeAsync(1_799_000)
    expect(sendToUser).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(sendToUser).toHaveBeenCalledTimes(1)

    digest.dispose()
  })
})
