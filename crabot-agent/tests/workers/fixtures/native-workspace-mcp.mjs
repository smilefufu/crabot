// Read-only MCP sentinel for real CLI acceptance. It has no Crabot or model connection.
import fs from 'node:fs/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
const server = new Server({ name: 'workspace-marker', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'get_marker', description: 'Read the private executor marker',
  inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] }))
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.name !== 'get_marker') throw new Error('Only the private marker is available')
  await fs.appendFile(process.env.MARKER_EVIDENCE, process.env.PRIVATE_MARKER + '\n')
  return { content: [{ type: 'text', text: process.env.PRIVATE_MARKER }] }
})
process.stdin.on('end', () => { void server.close().finally(() => process.exit(0)) })
await server.connect(new StdioServerTransport())
