import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createGuidanceMcpServerConfig } from '../../src/guidance/worker-bridge.js'

describe('CLI guidance bridge', () => {
  it('serves worker workflows without business credentials and refuses other roles and paths', async () => {
    const entry = createGuidanceMcpServerConfig()
    const client = new Client({ name: 'guidance-fixture', version: '1' })
    const transport = new StdioClientTransport({ command: entry.command!, args: entry.args, env: {} })
    try {
      await client.connect(transport)
      const tools = await client.listTools()
      expect(tools.tools.map(tool => tool.name)).toEqual(['load_guidance'])
      expect(tools.tools[0].annotations?.readOnlyHint).toBe(true)
      const result = await client.callTool({ name: 'load_guidance', arguments: { name: 'worker.diagnosis' } })
      expect(result.isError).toBe(false)
      expect(JSON.stringify(result.content)).toContain('找到最早发生偏差的环节')
      for (const name of ['manager.delegation', '/etc/passwd']) {
        expect((await client.callTool({ name: 'load_guidance', arguments: { name } })).isError).toBe(true)
      }
    } finally { await client.close(); await transport.close() }
  })
})
