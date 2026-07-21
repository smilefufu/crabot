import { describe, it, expect, vi } from 'vitest'
import { AnthropicAdapter } from '../../src/engine/anthropic-adapter'
import { normalizeMessagesForAnthropic } from '../../src/engine/anthropic-adapter'
import {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
  type ContentBlock,
  type EngineMessage,
  type ToolDefinition,
} from '../../src/engine/types'

// --- helpers ---

function makeFakeStream(): Record<string, unknown> {
  return {
    abort: vi.fn(),
    finalMessage: vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    [Symbol.asyncIterator]: async function* () {
      yield { type: 'message_start', message: { id: 'msg_1' } }
    },
  }
}

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    call: async () => ({ output: '', isError: false }),
  }
}

/** 跑一次 streamOnce（mock 掉 SDK stream），返回实际发给 API 的请求体 */
async function captureRequestBody(params: {
  messages: EngineMessage[]
  systemPrompt: string
  tools: ToolDefinition[]
}): Promise<Record<string, unknown>> {
  const adapter = new AnthropicAdapter({ endpoint: 'https://example.test', apikey: 'test-key' })
  const fakeStream = makeFakeStream()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spy = vi.spyOn((adapter as any).client.messages, 'stream').mockReturnValue(fakeStream)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gen = (adapter as any).streamOnce({
    messages: params.messages,
    systemPrompt: params.systemPrompt,
    tools: params.tools,
    model: 'claude-x',
  })
  for await (const _ of gen) {
    // drain
  }

  expect(spy).toHaveBeenCalledTimes(1)
  return spy.mock.calls[0][0] as Record<string, unknown>
}

const EPHEMERAL = { type: 'ephemeral' }

// --- 改动 1：prompt caching cache breakpoint ---

describe('Anthropic prompt caching（cache breakpoint 注入）', () => {
  it('system / 末位 tool / 末条消息末块 三处注入 cache_control，消息内容不被修改', async () => {
    const body = await captureRequestBody({
      systemPrompt: 'sys prompt',
      tools: [makeTool('Read'), makeTool('Bash')],
      messages: [
        createUserMessage('hi'),
        createAssistantMessage([{ type: 'text', text: 'hello' }], 'end_turn'),
        createUserMessage('go on'),
      ],
    })

    // 1) system 末尾：字符串改为带 cache_control 的 text block 数组，文本不变
    expect(body.system).toEqual([{ type: 'text', text: 'sys prompt', cache_control: EPHEMERAL }])

    // 2) tools 仅最后一个元素带 cache_control，name/description/schema 不变
    const tools = body.tools as Array<Record<string, unknown>>
    expect(tools).toHaveLength(2)
    expect(tools[0]).not.toHaveProperty('cache_control')
    expect(tools[0].name).toBe('Read')
    expect(tools[1].cache_control).toEqual(EPHEMERAL)
    expect(tools[1].name).toBe('Bash')
    expect(tools[1].description).toBe('Bash description')

    // 3) 最后一条消息（string content）被包装为数组，末块带 cache_control，文本不变
    const messages = body.messages as Array<{ role: string; content: unknown }>
    expect(messages).toHaveLength(3)
    expect(messages[0].content).toBe('hi')
    expect(messages[1].content).toEqual([{ type: 'text', text: 'hello' }])
    expect(messages[2].content).toEqual([
      { type: 'text', text: 'go on', cache_control: EPHEMERAL },
    ])
  })

  it('末条消息为 block 数组（tool_result）时，cache_control 加在最后一个 block 上且内容不变', async () => {
    const body = await captureRequestBody({
      systemPrompt: 'sys',
      tools: [makeTool('Read')],
      messages: [
        createUserMessage('run it'),
        createAssistantMessage(
          [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/tmp/a' } }],
          'tool_use',
        ),
        createToolResultMessage('tu_1', 'file content', false),
      ],
    })

    const messages = body.messages as Array<{ role: string; content: unknown }>
    // 前面的消息不带 cache_control
    expect(messages[0].content).toBe('run it')
    expect(messages[1].content).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/tmp/a' } },
    ])
    // 末条消息末块带 cache_control，tool_result 字段不变
    const lastContent = messages[2].content as Array<Record<string, unknown>>
    expect(lastContent).toHaveLength(1)
    expect(lastContent[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'file content',
      is_error: false,
      cache_control: EPHEMERAL,
    })
  })

  it('无 tools 且空 systemPrompt 时不传对应字段，消息末块仍有 cache_control', async () => {
    const body = await captureRequestBody({
      systemPrompt: '',
      tools: [],
      messages: [createUserMessage('hi')],
    })

    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('system')
    const messages = body.messages as Array<{ content: unknown }>
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'hi', cache_control: EPHEMERAL },
    ])
  })
})

// --- 改动 5：空 text block 过滤 ---

describe('Anthropic 序列化空 text block 过滤', () => {
  it('assistant 消息中不认识的 block（raw_reasoning）被丢弃，不产生空 text block', () => {
    const msg = createAssistantMessage(
      [
        { type: 'raw_reasoning', data: { reasoning_content: 'step 1' } },
        { type: 'text', text: 'final answer' },
      ],
      'end_turn',
    )
    const result = normalizeMessagesForAnthropic([msg])

    expect(result).toHaveLength(1)
    expect(result[0].content).toEqual([{ type: 'text', text: 'final answer' }])
  })

  it('assistant 消息全是不认识的 block 时整条消息被丢弃，不发 content: [] 给 API', () => {
    const msg = createAssistantMessage(
      [{ type: 'raw_reasoning', data: { reasoning_content: 'only reasoning' } }],
      'end_turn',
    )
    const result = normalizeMessagesForAnthropic([msg])

    expect(result).toHaveLength(0)
  })

  it('空 content 消息被丢弃不影响 tool_use/tool_result 配对：含 tool_use 的 assistant 保留', () => {
    const emptyAssistant = createAssistantMessage(
      [{ type: 'raw_reasoning', data: { reasoning_content: 'thinking' } }],
      'end_turn',
    )
    const toolUseAssistant = createAssistantMessage(
      [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/tmp/a' } }],
      'tool_use',
    )
    const toolResult = createToolResultMessage('tu_1', 'file content', false)
    const result = normalizeMessagesForAnthropic([emptyAssistant, toolUseAssistant, toolResult])

    // 空 assistant 被丢；tool_use 消息与其 tool_result 配对原样保留
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/tmp/a' } }],
    })
    expect(result[1].role).toBe('user')
    expect(result[1].content).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'file content', is_error: false },
    ])
  })

  it('user 消息 content blocks 中不认识的 block 被丢弃，text/image 不受影响', () => {
    const blocks: ContentBlock[] = [
      { type: 'raw_reasoning', data: { foo: 'bar' } },
      { type: 'text', text: 'look at this' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
      },
    ]
    const result = normalizeMessagesForAnthropic([createUserMessage(blocks)])

    expect(result[0].content).toEqual([
      { type: 'text', text: 'look at this' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
      },
    ])
  })

  it('正常 assistant 消息（text + tool_use）序列化结果不变', () => {
    const msg = createAssistantMessage(
      [
        { type: 'text', text: 'Let me help.' },
        { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'test' } },
      ],
      'tool_use',
    )
    const result = normalizeMessagesForAnthropic([msg])

    expect(result[0].content).toEqual([
      { type: 'text', text: 'Let me help.' },
      { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'test' } },
    ])
  })
})
