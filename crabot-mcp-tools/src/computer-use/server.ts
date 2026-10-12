import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { requestComputerUse } from './client.js'
import { errorResult } from './types.js'

/** Legacy MCP stdio is only a bridge; all input is serialized by the instance owner. */
export function createComputerUseServer(): Server {
  const server = new Server({ name: 'computer-use', version: '0.34.1' }, { capabilities: { tools: {} } })
  const request = (method: 'list' | 'call', name?: string, args?: Record<string, unknown>, scopedToken?: unknown) => {
    const endpoint = process.env.CRABOT_COMPUTER_USE_ENDPOINT
    const token = typeof scopedToken === 'string' ? scopedToken : process.env.CRABOT_COMPUTER_USE_TOKEN
    if (!endpoint || !token) throw new Error('COMPUTER_USE_HOST_REQUIRED')
    return requestComputerUse(endpoint, { token, method, name, args })
  }
  server.setRequestHandler(ListToolsRequestSchema, () => request('list'))
  server.setRequestHandler(CallToolRequestSchema, async message => {
    try { return await request('call', message.params.name, message.params.arguments ?? {}, message.params._meta?.crabot_computer_use_token) }
    catch (error) { return errorResult(error instanceof Error ? error.message : 'COMPUTER_USE_BRIDGE_FAILED') }
  })
  return server
}
