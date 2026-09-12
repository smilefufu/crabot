import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpConnector } from '../../src/agent/mcp-connector.js'
import { sha256CanonicalJson } from 'crabot-shared'

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: vi.fn() }))

const echo = { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }
function fixture(name = 'server') {
  const client = {
    connect: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [echo] }),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
  }
  vi.mocked(Client).mockImplementationOnce(() => client as never)
  const connector = new McpConnector()
  return { connector, client, connect: () => connector.connectAll([{ name, transport: 'stdio', command: 'fixture' }]) }
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers() })

describe('MCP catalog and execution safety', () => {
  it('读取完整分页（含空页），稳定排序，按 RFC 8785 计算 digest', async () => {
    const { connector, client, connect } = fixture()
    client.listTools.mockResolvedValueOnce({ tools: [{ ...echo, name: 'z' }], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ tools: [], nextCursor: 'page-3' })
      .mockResolvedValueOnce({ tools: [{ ...echo, name: 'a' }] })
    await connect()
    expect(client.listTools.mock.calls).toEqual([[undefined], [{ cursor: 'page-2' }], [{ cursor: 'page-3' }]])
    expect(connector.getAllTools().map((tool) => tool.name)).toEqual(['mcp__server__a', 'mcp__server__z'])
    expect(connector.getToolDefinitionDigest('mcp__server__a')).toBe(sha256CanonicalJson({
      name: 'mcp__server__a', description: 'Echo', inputSchema: echo.inputSchema,
    }))
  })

  it.each(['cursor', 'duplicate', 'invalid schema', 'control character', 'too many'])('非法目录 %s 不发布', async (kind) => {
    const { connector, client, connect } = fixture()
    if (kind === 'cursor') client.listTools.mockResolvedValue({ tools: [], nextCursor: 'same' })
    if (kind === 'duplicate') client.listTools.mockResolvedValue({ tools: [echo, echo] })
    if (kind === 'invalid schema') client.listTools.mockResolvedValue({ tools: [{ ...echo, inputSchema: { type: 'not-json-schema' } }] })
    if (kind === 'control character') client.listTools.mockResolvedValue({ tools: [{ ...echo, name: 'bad\u0000tool' }] })
    if (kind === 'too many') client.listTools.mockResolvedValue({ tools: Array.from({ length: 10_001 }, (_, i) => ({ ...echo, name: `t${i}` })) })
    await connect()
    expect(connector.getAllTools()).toEqual([])
    expect(connector.generation).toBe(0)
    expect(client.callTool).not.toHaveBeenCalled()
  })

  it('list-changed 发布新 generation，使旧 schema 在调用前失效', async () => {
    const { connector, client, connect } = fixture()
    await connect()
    const old = connector.getAllTools()[0]
    client.listTools.mockResolvedValue({ tools: [{ ...echo, description: 'Changed definition' }] })
    const options = vi.mocked(Client).mock.calls.at(-1)![1] as any
    options.listChanged.tools.onChanged(null)
    await vi.waitFor(() => expect(connector.generation).toBe(2))
    await expect(old.call({}, {})).resolves.toMatchObject({ output: 'TOOL_CATALOG_CHANGED', isError: true })
    expect(client.callTool).not.toHaveBeenCalled()
    expect(connector.getAllTools()[0].traceMetadata?.definition_digest).not.toBe(old.traceMetadata?.definition_digest)
    await expect(connector.getAllTools()[0].call({}, {})).resolves.toMatchObject({ output: 'ok' })
  })

  it('Manager 的 64 KiB 加载上限不截断共享 Worker 目录或排除同 server 的其它工具', async () => {
    const { connector, client, connect } = fixture()
    client.listTools.mockResolvedValue({ tools: [echo, {
      ...echo, name: 'large', inputSchema: { type: 'object', description: 'x'.repeat(66 * 1024) },
    }] })
    await connect()
    expect(connector.getAllTools().map((tool) => tool.name)).toEqual(['mcp__server__echo', 'mcp__server__large'])
    await expect(connector.getAllTools()[1].call({}, {})).resolves.toMatchObject({ output: 'ok', isError: false })
    expect(client.callTool).toHaveBeenCalledOnce()
  })

  it('包含双下划线的 server stale 后不可发现；成功刷新后恢复', async () => {
    const { connector, client, connect } = fixture('name__space')
    await connect()
    const old = connector.getAllTools()[0]
    client.listTools.mockRejectedValueOnce(new Error('bad list'))
    await (connector as any).refreshToolCache()
    expect(connector.getAllTools()).toEqual([])
    await expect(old.call({}, {})).resolves.toMatchObject({ output: 'TOOL_CATALOG_CHANGED' })
    expect(client.callTool).not.toHaveBeenCalled()
    await (connector as any).refreshToolCache()
    expect(connector.getAllTools()).toHaveLength(1)
  })

  it('合并 hidden defaults 后才验证输入；拒绝时无外部调用且不回显 defaults', async () => {
    const { connector, client } = fixture()
    client.listTools.mockResolvedValue({ tools: [{ ...echo, inputSchema: {
      type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false,
    } }] })
    await connector.connectAll([{ name: 'server', command: 'fixture', tool_defaults: { echo: { token: 'private-default' } } }])
    const tool = connector.getAllTools()[0]
    await expect(tool.call({}, {})).resolves.toMatchObject({ isError: false })
    expect(client.callTool.mock.calls[0][0].arguments).toEqual({ token: 'private-default' })
    const result = await tool.call({ token: 5 }, {})
    expect(result.output).toContain('MCP_INPUT_INVALID')
    expect(JSON.stringify(result)).not.toContain('private-default')
    expect(client.callTool).toHaveBeenCalledTimes(1)
  })

  it('旧连接的迟到列举失败不得把已替换的新连接标记 stale', async () => {
    const { connector, client, connect } = fixture()
    await connect()
    let rejectList!: (error: Error) => void
    client.listTools.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectList = reject }))
    const refreshing = (connector as any).refreshToolCache()
    const replacement = fixture()
    await replacement.connect()
    await connector.replaceWith(replacement.connector)

    rejectList(new Error('retired connection'))
    await refreshing
    expect(connector.getAllTools()).toHaveLength(1)
    await expect(connector.getAllTools()[0].call({}, {})).resolves.toMatchObject({ output: 'ok', isError: false })
    expect(replacement.client.callTool).toHaveBeenCalledOnce()
    expect(client.callTool).not.toHaveBeenCalled()
  })

  it('list-changed 重建期间旧快照立即失效，避免调用已变更的接口', async () => {
    const { connector, client, connect } = fixture()
    await connect()
    const old = connector.getAllTools()[0]
    let resolveList!: (value: { tools: typeof echo[] }) => void
    client.listTools.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve }))
    const options = vi.mocked(Client).mock.calls.at(-1)![1] as any
    options.listChanged.tools.onChanged(null)
    await expect(old.call({}, {})).resolves.toMatchObject({ output: 'TOOL_CATALOG_CHANGED' })
    expect(connector.getAllTools()).toEqual([])
    expect(client.callTool).not.toHaveBeenCalled()
    resolveList({ tools: [echo] })
    await vi.waitFor(() => expect(connector.getAllTools()).toHaveLength(1))
  })

  it('首次连接只有非法 server 被排除，其半份目录不影响其它合法 server', async () => {
    const broken = fixture('broken')
    const healthy = fixture('healthy')
    broken.client.listTools.mockResolvedValue({ tools: [echo, { ...echo, name: 'invalid', inputSchema: { type: 'invalid' } }] })
    await broken.connector.connectAll([{ name: 'broken', command: 'fixture' }, { name: 'healthy', command: 'fixture' }])
    expect(broken.connector.getAllTools().map((tool) => tool.name)).toEqual(['mcp__healthy__echo'])
    await expect(broken.connector.getAllTools()[0].call({}, {})).resolves.toMatchObject({ output: 'ok' })
    expect(healthy.client.callTool).toHaveBeenCalledOnce()
    expect(broken.client.callTool).not.toHaveBeenCalled()
  })

  it('连接意外关闭后立即退出可发现目录，已加载定义不可调用', async () => {
    const { connector, client, connect } = fixture()
    await connect()
    const old = connector.getAllTools()[0]
    ;(client as unknown as Client).onclose?.()
    expect(connector.getAllTools()).toEqual([])
    await expect(old.call({}, {})).resolves.toMatchObject({ output: 'TOOL_CATALOG_CHANGED' })
    expect(client.callTool).not.toHaveBeenCalled()
  })

  it('相同 schema $id 的合法更新不会被旧 validator 缓存阻止', async () => {
    const { connector, client, connect } = fixture()
    client.listTools.mockResolvedValueOnce({ tools: [{ ...echo, inputSchema: { ...echo.inputSchema, $id: 'urn:test:schema', required: ['before'] } }] })
    await connect()
    client.listTools.mockResolvedValueOnce({ tools: [{ ...echo, inputSchema: { ...echo.inputSchema, $id: 'urn:test:schema', required: ['after'] } }] })
    await (connector as any).refreshToolCache()
    expect(connector.generation).toBe(2)
    await expect(connector.getAllTools()[0].call({ after: true }, {})).resolves.toMatchObject({ output: 'ok' })
  })

  it('outputSchema 校验失败不把未验证的结构交给 LLM', async () => {
    const { connector, client, connect } = fixture()
    client.listTools.mockResolvedValue({ tools: [{ ...echo, outputSchema: { type: 'object', required: ['ok'] } }] })
    client.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'unvalidated' }], structuredContent: {} })
    await connect()
    await expect(connector.getAllTools()[0].call({}, {})).resolves.toMatchObject({ output: 'MCP_OUTPUT_INVALID', isError: true })
    expect(client.callTool).toHaveBeenCalledTimes(1)
  })

  it('120 秒超时取消请求，只调用一次并记 timeout', async () => {
    vi.useFakeTimers()
    const { connector, client, connect } = fixture()
    await connect()
    client.callTool.mockImplementation((_input, _schema, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    }))
    const call = connector.getAllTools()[0].call({}, {})
    await vi.advanceTimersByTimeAsync(120_000)
    await expect(call).resolves.toMatchObject({ output: 'MCP_TIMEOUT', isError: true, traceMetadata: { mcp_timed_out: true } })
    expect(client.callTool).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('已取消的调用不产生 MCP 副作用', async () => {
    const { connector, client, connect } = fixture()
    await connect()
    await expect(connector.getAllTools()[0].call({}, { abortSignal: AbortSignal.abort() })).resolves.toMatchObject({ isError: true })
    expect(client.callTool).not.toHaveBeenCalled()
  })

  it('图片严格 base64、解码大小和数量有上限；其它 block 明确标记', async () => {
    const { connector, client, connect } = fixture()
    await connect()
    client.callTool.mockResolvedValue({ content: [
      { type: 'image', data: 'Zh==' },
      { type: 'image', data: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') },
      ...Array.from({ length: 3 }, () => ({ type: 'image', data: 'Zg==', mimeType: 'image/png' })),
      { type: 'resource_link', uri: 'https://example.invalid' }, { type: 'audio', data: 'Zg==' }, { type: 'unknown' },
    ] })
    const result = await connector.getAllTools()[0].call({}, {})
    expect(result.images).toHaveLength(2)
    expect(result.output).toContain('invalid or over limit')
    expect(result.output).toContain('maximum 2 images')
    expect(result.output).toContain('resource link omitted')
    expect(result.output).toContain('audio omitted')
    expect(result.output).toContain('unsupported MCP content block')
    expect(result.traceMetadata?.mcp_content_blocks_omitted).toBe(true)
  })
})
