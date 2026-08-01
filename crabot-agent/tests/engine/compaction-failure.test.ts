import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop.js'
import { defineTool } from '../../src/engine/tool-framework.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter.js'
import { createUserMessage } from '../../src/engine/types.js'
import type { StreamChunk, EngineOptions, EngineMessage } from '../../src/engine/types.js'

/**
 * 上下文压缩故障链回归（研究报告 `.superpowers/sdd/pi-compaction-study.md` §五）：
 * 摘要 LLM 失败时 engine 不得把"假压缩"当成压缩成功，abort 必须穿透。
 */

const readTool = defineTool({
  name: 'Read',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  isReadOnly: true,
  call: async () => ({ output: 'file content', isError: false }),
})

function baseOptions(overrides: Partial<EngineOptions> = {}): EngineOptions {
  return {
    systemPrompt: 'You are a test assistant.',
    tools: [],
    model: 'test-model',
    maxTurns: 10,
    ...overrides,
  }
}

function toolUseResponse(
  usage: { inputTokens: number; outputTokens: number },
): ReadonlyArray<StreamChunk> {
  return [
    { type: 'message_start', messageId: 'msg-1' },
    { type: 'tool_use_start', id: 'tu-1', name: 'Read' },
    { type: 'tool_use_delta', id: 'tu-1', inputJson: JSON.stringify({ path: '/tmp/a' }) },
    { type: 'tool_use_end', id: 'tu-1' },
    { type: 'message_end', stopReason: 'tool_use', usage },
  ]
}

function textResponse(text: string): ReadonlyArray<StreamChunk> {
  return [
    { type: 'message_start', messageId: 'msg-1' },
    { type: 'text_delta', text },
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
  ]
}

/**
 * 5 轮 tool_use（messages 达 11 条 > keepRecentMessages=6），第 5 轮 usage 90 >= 阈值 80，
 * 第 6 轮开始前触发压缩。第 6 次 adapter 调用就是压缩摘要调用。
 */
function historyResponses(): ReadonlyArray<ReadonlyArray<StreamChunk>> {
  const small = { inputTokens: 10, outputTokens: 10 }
  return [
    toolUseResponse(small),
    toolUseResponse(small),
    toolUseResponse(small),
    toolUseResponse(small),
    toolUseResponse({ inputTokens: 90, outputTokens: 10 }),
  ]
}

/** 前 5 次正常，第 6 次（摘要调用）按 onSummaryCall 决定行为 */
function adapterFailingOnSummary(
  onSummaryCall: () => AsyncGenerator<StreamChunk>,
): LLMAdapter {
  const history = historyResponses()
  let callIndex = 0
  return {
    async *stream(params) {
      const index = callIndex++
      if (index < history.length) {
        for (const chunk of history[index]) yield chunk
        return
      }
      // 摘要调用（也可能是压缩之后的主轮调用）
      for await (const chunk of onSummaryCall()) {
        if (params.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }
        yield chunk
      }
    },
    updateConfig() {},
  }
}

function hasSummaryMessage(messages: ReadonlyArray<EngineMessage>): boolean {
  return messages.some(
    (m) =>
      m.role === 'user' &&
      typeof (m as { content?: unknown }).content === 'string' &&
      ((m as { content: string }).content.includes('[Earlier conversation summary]') ||
        (m as { content: string }).content.includes('[Summary of earlier conversation]')),
  )
}

describe('runEngine context compaction failure', () => {
  it('fails the run instead of silently continuing on a fake compaction', async () => {
    const adapter = adapterFailingOnSummary(async function* () {
      yield { type: 'error', error: 'summary provider 429 (retries exhausted)' } as StreamChunk
    })
    const onCompactionEnd = vi.fn()

    const result = await runEngine({
      prompt: 'hi',
      adapter,
      options: baseOptions({
        tools: [readTool],
        contextWindowTokens: 100,
        onCompactionEnd,
      }),
    })

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('上下文压缩失败')
    expect(result.error).toContain('429')
    // messages 未被"假压缩"改写
    expect(hasSummaryMessage(result.finalMessages)).toBe(false)
    // onCompactionEnd 不得谎报成功
    expect(onCompactionEnd).toHaveBeenCalledTimes(1)
    const info = onCompactionEnd.mock.calls[0][0] as {
      beforeCount: number
      afterCount: number
      failedReason?: string
    }
    expect(info.failedReason).toBeDefined()
    expect(info.afterCount).toBe(info.beforeCount)
  })

  it('does not rewrite messages when the run is aborted during compaction', async () => {
    const controller = new AbortController()
    const adapter = adapterFailingOnSummary(async function* () {
      // 摘要调用刚开始就被用户取消
      controller.abort()
      yield { type: 'message_start', messageId: 'msg-x' } as StreamChunk
      yield { type: 'text_delta', text: '摘要（不该被采用）' } as StreamChunk
      yield { type: 'message_end', stopReason: 'end_turn' } as StreamChunk
    })

    const result = await runEngine({
      prompt: 'hi',
      adapter,
      options: baseOptions({
        tools: [readTool],
        contextWindowTokens: 100,
        abortSignal: controller.signal,
      }),
    })

    expect(result.outcome).toBe('aborted')
    // abort 途中不许再改一次上下文
    expect(hasSummaryMessage(result.finalMessages)).toBe(false)
  })

  it('reports compaction failure in the max_tokens compact-retry path', async () => {
    // 主轮 max_tokens + 空文本 → 走 compact-retry；此时摘要调用失败
    const responses: ReadonlyArray<ReadonlyArray<StreamChunk>> = [
      [
        { type: 'message_start', messageId: 'msg-1' },
        { type: 'message_end', stopReason: 'max_tokens', usage: { inputTokens: 10, outputTokens: 0 } },
      ],
    ]
    let callIndex = 0
    const adapter: LLMAdapter = {
      async *stream() {
        const index = callIndex++
        if (index < responses.length) {
          for (const chunk of responses[index]) yield chunk
          return
        }
        yield { type: 'error', error: 'summary provider down' } as StreamChunk
      },
      updateConfig() {},
    }

    const initialMessages: EngineMessage[] = ['任务来源', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].map(
      (text) => createUserMessage(text),
    )

    const result = await runEngine({
      prompt: 'unused',
      initialMessages,
      adapter,
      options: baseOptions({ contextWindowTokens: 100000 }),
    })

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('上下文压缩失败')
    expect(hasSummaryMessage(result.finalMessages)).toBe(false)
  })

  it('still completes normally when compaction succeeds', async () => {
    // 反向不变量：成功路径行为不变（压缩成功 → 摘要进上下文 → 继续跑到 completed）
    let phase = 0
    const history = historyResponses()
    const adapter: LLMAdapter = {
      async *stream() {
        const index = phase++
        const chunks =
          index < history.length
            ? history[index]
            : index === history.length
              ? textResponse('对话摘要')
              : textResponse('done')
        for (const chunk of chunks) yield chunk
      },
      updateConfig() {},
    }
    const onCompactionEnd = vi.fn()

    const result = await runEngine({
      prompt: 'hi',
      adapter,
      options: baseOptions({ tools: [readTool], contextWindowTokens: 100, onCompactionEnd }),
    })

    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('done')
    expect(hasSummaryMessage(result.finalMessages)).toBe(true)
    const info = onCompactionEnd.mock.calls[0][0] as { failedReason?: string; afterCount: number; beforeCount: number }
    expect(info.failedReason).toBeUndefined()
    expect(info.afterCount).toBeLessThan(info.beforeCount)
  })
})
