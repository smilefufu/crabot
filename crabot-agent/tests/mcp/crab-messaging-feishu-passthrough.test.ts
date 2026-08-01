import { describe, it, expect, vi } from 'vitest'
import { buildWorkerMessagingTools } from '../../src/mcp/crab-messaging.js'

function findTool(tools: ReturnType<typeof buildWorkerMessagingTools>, name: string) {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

function parse(out: Awaited<ReturnType<ReturnType<typeof buildWorkerMessagingTools>[number]['handler']>>) {
  return JSON.parse((out as { content: Array<{ text: string }> }).content[0].text)
}

// makeDeps で list_channel_instances を rpcClient.call で制御し、resolveChannelPort で channel port を解決する
function makeDeps(opts: {
  rpcCall?: ReturnType<typeof vi.fn>
  resolveChannelPort?: (id: string) => Promise<number>
  enableFeishuDocTool?: boolean
}) {
  const rpcCall = opts.rpcCall ?? vi.fn()
  return {
    rpcClient: { call: rpcCall } as never,
    moduleId: 'agent-test',
    getAdminPort: async () => 19001,
    resolveChannelPort: opts.resolveChannelPort ?? (async (id: string) => (id === 'feishu-1' ? 19010 : 0)),
    enableFeishuDocTool: opts.enableFeishuDocTool ?? true,
  }
}

describe('feishu_raw_get / feishu_download_file 门控', () => {
  it('enableFeishuDocTool=true → feishu_raw_get 与 feishu_download_file 出现在工具列表', () => {
    const tools = buildWorkerMessagingTools(makeDeps({ enableFeishuDocTool: true }))
    expect(tools.find(t => t.name === 'feishu_raw_get')).toBeDefined()
    expect(tools.find(t => t.name === 'feishu_download_file')).toBeDefined()
    expect(tools.find(t => t.name === 'read_feishu_document')).toBeDefined()
  })

  it('enableFeishuDocTool=false → feishu_raw_get 与 feishu_download_file 都不出现', () => {
    const tools = buildWorkerMessagingTools(makeDeps({ enableFeishuDocTool: false }))
    expect(tools.find(t => t.name === 'feishu_raw_get')).toBeUndefined()
    expect(tools.find(t => t.name === 'feishu_download_file')).toBeUndefined()
    expect(tools.find(t => t.name === 'read_feishu_document')).toBeUndefined()
  })

  it('enableFeishuDocTool 未传 (undefined) → 飞书工具不出现', () => {
    const tools = buildWorkerMessagingTools({
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'agent-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19010,
    })
    expect(tools.find(t => t.name === 'feishu_raw_get')).toBeUndefined()
    expect(tools.find(t => t.name === 'feishu_download_file')).toBeUndefined()
  })
})

describe('feishu_raw_get handler', () => {
  it('单个飞书 channel 时调用 feishu_get RPC 并透传结果', async () => {
    const rpcCall = vi.fn().mockImplementation(
      async (_port: number, method: string, _params: unknown) => {
        if (method === 'list_channel_instances') {
          return { items: [{ id: 'feishu-1', implementation_id: 'channel-feishu' }] }
        }
        if (method === 'feishu_get') return { data: { code: 0, msg: 'success', data: { title: 'hello' } } }
        return {}
      },
    )
    const tools = buildWorkerMessagingTools(makeDeps({ rpcCall, enableFeishuDocTool: true }))
    const out = await findTool(tools, 'feishu_raw_get').handler({
      path: '/open-apis/wiki/v2/spaces/get_node',
      query: { token: 'abc123' },
    })
    // 确认对 adminPort 调 list_channel_instances
    expect(rpcCall).toHaveBeenCalledWith(
      19001,
      'list_channel_instances',
      { pagination: { page: 1, page_size: 50 } },
      'agent-test',
    )
    // 确认对 channelPort 调 feishu_get
    expect(rpcCall).toHaveBeenCalledWith(
      19010,
      'feishu_get',
      { path: '/open-apis/wiki/v2/spaces/get_node', query: { token: 'abc123' } },
      'agent-test',
    )
    const result = parse(out)
    expect(result.data).toBeDefined()
    expect(result.data.code).toBe(0)
  })

  it('channel_id 直接传入时跳过 list_channel_instances，直接路由到指定 channel', async () => {
    const rpcCall = vi.fn().mockImplementation(
      async (_port: number, method: string) => {
        if (method === 'feishu_get') return { data: { ok: true } }
        return {}
      },
    )
    const tools = buildWorkerMessagingTools(makeDeps({ rpcCall, enableFeishuDocTool: true }))
    const out = await findTool(tools, 'feishu_raw_get').handler({
      path: '/open-apis/im/v1/messages',
      channel_id: 'feishu-1',
    })
    // list_channel_instances 不应被调用
    expect(rpcCall).not.toHaveBeenCalledWith(
      expect.anything(),
      'list_channel_instances',
      expect.anything(),
      expect.anything(),
    )
    expect(rpcCall).toHaveBeenCalledWith(
      19010,
      'feishu_get',
      { path: '/open-apis/im/v1/messages' },
      'agent-test',
    )
    const result = parse(out)
    expect(result.data.ok).toBe(true)
  })

  it('query 未传时不在 RPC 参数里出现 query 字段', async () => {
    const rpcCall = vi.fn().mockImplementation(
      async (_port: number, method: string) => {
        if (method === 'list_channel_instances') {
          return { items: [{ id: 'feishu-1', implementation_id: 'channel-feishu' }] }
        }
        if (method === 'feishu_get') return { data: {} }
        return {}
      },
    )
    const tools = buildWorkerMessagingTools(makeDeps({ rpcCall, enableFeishuDocTool: true }))
    await findTool(tools, 'feishu_raw_get').handler({ path: '/open-apis/foo/bar' })
    // 调 feishu_get 时 params 不含 query 键
    const feishuGetCall = rpcCall.mock.calls.find((c: unknown[]) => c[1] === 'feishu_get')
    expect(feishuGetCall).toBeDefined()
    expect(Object.keys(feishuGetCall![2] as object)).not.toContain('query')
  })
})

describe('feishu_download_file handler', () => {
  it('单个飞书 channel 时调用 feishu_download RPC 并透传结果', async () => {
    const rpcCall = vi.fn().mockImplementation(
      async (_port: number, method: string) => {
        if (method === 'list_channel_instances') {
          return { items: [{ id: 'feishu-1', implementation_id: 'channel-feishu' }] }
        }
        if (method === 'feishu_download') return { handle: 'fm_abc123', status: 'not_fetched' }
        return {}
      },
    )
    const tools = buildWorkerMessagingTools(makeDeps({ rpcCall, enableFeishuDocTool: true }))
    const out = await findTool(tools, 'feishu_download_file').handler({
      file_token: 'boxTokABC',
      filename: 'report.pdf',
    })
    expect(rpcCall).toHaveBeenCalledWith(
      19010,
      'feishu_download',
      { file_token: 'boxTokABC', filename: 'report.pdf' },
      'agent-test',
    )
    const result = parse(out)
    expect(result.handle).toBe('fm_abc123')
    expect(result.status).toBe('not_fetched')
  })

  it('filename 未传时 feishu_download params 不含 filename 字段', async () => {
    const rpcCall = vi.fn().mockImplementation(
      async (_port: number, method: string) => {
        if (method === 'list_channel_instances') {
          return { items: [{ id: 'feishu-1', implementation_id: 'channel-feishu' }] }
        }
        if (method === 'feishu_download') return { handle: 'fm_xyz', status: 'not_fetched' }
        return {}
      },
    )
    const tools = buildWorkerMessagingTools(makeDeps({ rpcCall, enableFeishuDocTool: true }))
    await findTool(tools, 'feishu_download_file').handler({ file_token: 'boxTok' })
    const downloadCall = rpcCall.mock.calls.find((c: unknown[]) => c[1] === 'feishu_download')
    expect(downloadCall).toBeDefined()
    expect(Object.keys(downloadCall![2] as object)).not.toContain('filename')
  })
})

describe('feishu_write 门控', () => {
  it('enableFeishuDocTool=true → feishu_write 出现在工具列表', () => {
    const tools = buildWorkerMessagingTools(makeDeps({ enableFeishuDocTool: true }))
    expect(tools.find(t => t.name === 'feishu_write')).toBeDefined()
  })

  it('enableFeishuDocTool=false → feishu_write 不出现', () => {
    const tools = buildWorkerMessagingTools(makeDeps({ enableFeishuDocTool: false }))
    expect(tools.find(t => t.name === 'feishu_write')).toBeUndefined()
  })
})

describe('feishu_write handler', () => {
  it('单个飞书 channel 时调用 feishu_write RPC 并透传结果', async () => {
    const rpcCall = vi.fn().mockImplementation(
      async (_port: number, method: string) => {
        if (method === 'list_channel_instances') {
          return { items: [{ id: 'feishu-1', implementation_id: 'channel-feishu' }] }
        }
        if (method === 'feishu_write') return { data: { code: 0, msg: 'success' } }
        return {}
      },
    )
    const tools = buildWorkerMessagingTools(makeDeps({ rpcCall, enableFeishuDocTool: true }))
    const out = await findTool(tools, 'feishu_write').handler({
      method: 'POST',
      path: '/open-apis/im/v1/messages',
      body: { receive_id: 'oc_abc', msg_type: 'text', content: '{"text":"hello"}' },
    })
    // 确认对 channelPort 调 feishu_write，透传 method/path/body
    expect(rpcCall).toHaveBeenCalledWith(
      19010,
      'feishu_write',
      {
        method: 'POST',
        path: '/open-apis/im/v1/messages',
        body: { receive_id: 'oc_abc', msg_type: 'text', content: '{"text":"hello"}' },
      },
      'agent-test',
    )
    const result = parse(out)
    expect(result.data).toBeDefined()
    expect(result.data.code).toBe(0)
  })

  it('body 未传时 feishu_write RPC params 不含 body 字段', async () => {
    const rpcCall = vi.fn().mockImplementation(
      async (_port: number, method: string) => {
        if (method === 'list_channel_instances') {
          return { items: [{ id: 'feishu-1', implementation_id: 'channel-feishu' }] }
        }
        if (method === 'feishu_write') return { data: {} }
        return {}
      },
    )
    const tools = buildWorkerMessagingTools(makeDeps({ rpcCall, enableFeishuDocTool: true }))
    await findTool(tools, 'feishu_write').handler({
      method: 'DELETE',
      path: '/open-apis/im/v1/messages/msg_abc',
    })
    const writeCall = rpcCall.mock.calls.find((c: unknown[]) => c[1] === 'feishu_write')
    expect(writeCall).toBeDefined()
    expect(Object.keys(writeCall![2] as object)).not.toContain('body')
  })
})

describe('feishu_write 不在 DAILY_REFLECTION_ALLOWED_TOOLS', () => {
  it('daily_reflection 任务中 feishu_write 不出现', () => {
    const rpcCall = vi.fn()
    const tools = buildWorkerMessagingTools({
      rpcClient: { call: rpcCall } as never,
      moduleId: 'agent-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19010,
      enableFeishuDocTool: true,
      getTaskContext: () => ({
        taskId: 'task-1',
        humanQueue: null as never,
        triggerType: 'scheduled',
        taskType: 'daily_reflection',
        hasGoal: () => false,
      }),
    })
    expect(tools.find(t => t.name === 'feishu_write')).toBeUndefined()
  })
})

describe('resolveFeishuChannelPort 错误分支（通过 feishu_raw_get 触发）', () => {
  it('无飞书 channel → 返回 error_code: CHANNEL_UNAVAILABLE', async () => {
    const rpcCall = vi.fn().mockImplementation(
      async (_port: number, method: string) => {
        if (method === 'list_channel_instances') {
          return { items: [] }
        }
        return {}
      },
    )
    const tools = buildWorkerMessagingTools(makeDeps({ rpcCall, enableFeishuDocTool: true }))
    const out = await findTool(tools, 'feishu_raw_get').handler({ path: '/open-apis/wiki/v2/spaces' })
    const result = parse(out)
    expect(result.error_code).toBe('CHANNEL_UNAVAILABLE')
    expect(result.error).toBeDefined()
  })

  it('list_channel_instances RPC 报错 → error_code: CHANNEL_UNAVAILABLE', async () => {
    const rpcCall = vi.fn().mockImplementation(
      async (_port: number, method: string) => {
        if (method === 'list_channel_instances') throw new Error('network error')
        return {}
      },
    )
    const tools = buildWorkerMessagingTools(makeDeps({ rpcCall, enableFeishuDocTool: true }))
    const out = await findTool(tools, 'feishu_raw_get').handler({ path: '/open-apis/foo' })
    const result = parse(out)
    expect(result.error_code).toBe('CHANNEL_UNAVAILABLE')
  })

  it('多个飞书 channel 且未传 channel_id → error_code: AMBIGUOUS，含 available_channels', async () => {
    const rpcCall = vi.fn().mockImplementation(
      async (_port: number, method: string) => {
        if (method === 'list_channel_instances') {
          return {
            items: [
              { id: 'feishu-1', implementation_id: 'channel-feishu' },
              { id: 'feishu-2', implementation_id: 'channel-feishu' },
            ],
          }
        }
        return {}
      },
    )
    const tools = buildWorkerMessagingTools(makeDeps({ rpcCall, enableFeishuDocTool: true }))
    const out = await findTool(tools, 'feishu_raw_get').handler({ path: '/open-apis/wiki/v2/spaces' })
    const result = parse(out)
    expect(result.error_code).toBe('AMBIGUOUS')
    expect(Array.isArray(result.available_channels)).toBe(true)
    expect(result.available_channels).toContain('feishu-1')
    expect(result.available_channels).toContain('feishu-2')
  })

  it('channel_id 指定但 resolveChannelPort 抛错 → error_code: CHANNEL_UNAVAILABLE', async () => {
    const tools = buildWorkerMessagingTools(makeDeps({
      rpcCall: vi.fn(),
      resolveChannelPort: async () => { throw new Error('port not found') },
      enableFeishuDocTool: true,
    }))
    const out = await findTool(tools, 'feishu_raw_get').handler({
      path: '/open-apis/foo',
      channel_id: 'feishu-gone',
    })
    const result = parse(out)
    expect(result.error_code).toBe('CHANNEL_UNAVAILABLE')
    expect(result.error).toContain('feishu-gone')
  })
})
