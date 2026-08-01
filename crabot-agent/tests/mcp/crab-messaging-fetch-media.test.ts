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

function makeDeps(call: ReturnType<typeof vi.fn>) {
  return {
    rpcClient: { call } as never,
    moduleId: 'agent-test',
    getAdminPort: async () => 19001,
    resolveChannelPort: async (id: string) => (id === 'feishu-1' ? 19010 : 0),
  } as never
}

describe('fetch_media 工具', () => {
  it('路由到 channelPort.fetch_media 并把 file_path 透传', async () => {
    const call = vi.fn().mockResolvedValue({
      status: 'ready',
      file_path: '/data/media/om_f.pdf',
      mime_type: 'application/pdf',
    })
    const tools = buildWorkerMessagingTools(makeDeps(call))
    const out = await findTool(tools, 'fetch_media').handler({
      channel_id: 'feishu-1',
      handle: 'fm_abc',
    })
    expect(call).toHaveBeenCalledWith(19010, 'fetch_media', { handle: 'fm_abc' }, 'agent-test')
    const result = parse(out)
    expect(result.file_path).toBe('/data/media/om_f.pdf')
    expect(result.status).toBe('ready')
  })

  it('channel 不可用 → 结构化错误', async () => {
    const tools = buildWorkerMessagingTools(makeDeps(vi.fn()))
    const out = await findTool(tools, 'fetch_media').handler({
      channel_id: 'unknown',
      handle: 'fm_x',
    })
    expect(parse(out).error).toBeTruthy()
  })

  it('status=failed 透传原因', async () => {
    const call = vi.fn().mockResolvedValue({
      status: 'failed',
      error: 'unknown media handle',
    })
    const tools = buildWorkerMessagingTools(makeDeps(call))
    const out = await findTool(tools, 'fetch_media').handler({
      channel_id: 'feishu-1',
      handle: 'fm_bad',
    })
    const result = parse(out)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('unknown media handle')
  })

  it('status=fetching → 结果含调用 wait_for_signal 的提示', async () => {
    const call = vi.fn().mockResolvedValue({ status: 'fetching' })
    const tools = buildWorkerMessagingTools(makeDeps(call))
    const out = await findTool(tools, 'fetch_media').handler({ channel_id: 'feishu-1', handle: 'fm_big' })
    const parsed = parse(out)
    expect(parsed.status).toBe('fetching')
    expect(JSON.stringify(parsed)).toContain('wait_for_signal')
  })
})
