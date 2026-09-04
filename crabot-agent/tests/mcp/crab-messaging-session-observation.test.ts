import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  buildWorkerMessagingTools,
  createCrabMessagingServer,
} from '../../src/mcp/crab-messaging.js'

function findTool(tools: ReturnType<typeof buildWorkerMessagingTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`tool ${name} not found`)
  return tool
}

function makeDeps(call: ReturnType<typeof vi.fn>) {
  return {
    rpcClient: { call } as never,
    moduleId: 'agent-test',
    getAdminPort: async () => 19001,
    resolveChannelPort: async () => 19009,
    getTaskContext: () => null,
  }
}

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()))
})

describe('crab-messaging Session 归属观察', () => {
  it('get_history 仅在目标查询整体成功后暴露结构化观察', async () => {
    const successCall = vi.fn(async (_port: number, method: string) => {
      if (method === 'get_history') return { items: [] }
      throw new Error(`unexpected RPC: ${method}`)
    })
    const successTool = findTool(buildWorkerMessagingTools(makeDeps(successCall)), 'get_history')

    const success = await successTool.handler({ channel_id: 'ch-1', session_id: 'sess-1' })

    expect(success.observedSessionTargets).toEqual([
      { channel_id: 'ch-1', session_id: 'sess-1' },
    ])
    expect(JSON.parse(success.content[0].text)).not.toHaveProperty('observedSessionTargets')

    const failureTool = findTool(buildWorkerMessagingTools(makeDeps(
      vi.fn(async () => { throw new Error('channel down') }),
    )), 'get_history')
    const failure = await failureTool.handler({ channel_id: 'ch-1', session_id: 'untrusted' })

    expect(failure.observedSessionTargets).toBeUndefined()
    expect(JSON.parse(failure.content[0].text)).toHaveProperty('error')
  })

  it('raw MCP 响应剥离 Manager 内部的 observedSessionTargets 元数据', async () => {
    const call = vi.fn(async (_port: number, method: string) => {
      if (method === 'get_sessions') {
        return {
          items: [{ id: 'sess-1', channel_id: 'ch-1', type: 'private' }],
          pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 },
        }
      }
      throw new Error(`unexpected RPC: ${method}`)
    })
    const server = createCrabMessagingServer(makeDeps(call))
    const client = new Client(
      { name: 'crab-messaging-observation-test', version: '1.0.0' },
      { capabilities: {} },
    )
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    cleanup.push(async () => { await client.close() })
    cleanup.push(async () => { await server.close() })
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const result = await client.callTool({
      name: 'list_sessions',
      arguments: { channel_id: 'ch-1' },
    })

    expect(result).not.toHaveProperty('observedSessionTargets')
    const text = result.content.find((block) => block.type === 'text')
    if (!text || text.type !== 'text') throw new Error('list_sessions returned no text result')
    expect(JSON.parse(text.text)).not.toHaveProperty('observedSessionTargets')
  })
})
