import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createComputerUseServer } from '../src/computer-use/server'
import { createComputerUseBridge } from '../src/computer-use/service'
import { ComputerUseCoordinator } from '../src/computer-use/coordinator'
import { NATIVE_TOOLS } from '../src/computer-use/types'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  delete process.env.CRABOT_COMPUTER_USE_ENDPOINT
  delete process.env.CRABOT_COMPUTER_USE_TOKEN
})

describe('computer-use MCP → instance bridge → native fixture', () => {
  it('coordinates four caller sessions, preserves native evidence, and enforces live revocation', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'cu-wire-'))
    cleanup.push(() => fs.rm(directory, { recursive: true, force: true }))
    const sessions: string[] = []
    const grants = new Set(['manager', 'builtin', 'claude-code', 'codex'])
    const coordinator = new ComputerUseCoordinator({
      async tools() { return NATIVE_TOOLS.map(name => ({ name, inputSchema: { type: 'object', properties: {
        session: { type: 'string' }, text: { type: 'string' },
      }, additionalProperties: false } })) },
      async call(name, args) {
        if (name === 'start_session') return { content: [] }
        sessions.push(String(args.session))
        return { content: [], structuredContent: { effect: 'unverifiable', verified: false, path: 'native', echoed: args.text } }
      },
      async close() {},
    }, async token => grants.has(token))
    const bridge = createComputerUseBridge(coordinator, async (token, method) => method === 'list' ? token === 'catalog' || grants.has(token) : grants.has(token))
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\cu-wire-${Date.now()}` : join(directory, 's.sock')
    await new Promise<void>(done => bridge.server.listen(endpoint, done))
    cleanup.push(async () => { bridge.close(); await coordinator.close() })
    process.env.CRABOT_COMPUTER_USE_ENDPOINT = endpoint
    process.env.CRABOT_COMPUTER_USE_TOKEN = 'catalog'
    for (const caller of grants) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      const server = createComputerUseServer()
      const client = new Client({ name: caller, version: 'test' })
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      cleanup.push(() => client.close())
      const tools = await client.listTools()
      expect(tools.tools.map(tool => tool.name)).toContain('perform_actions')
      const response = await client.callTool({ name: 'type_text', arguments: { text: '中文😀' }, _meta: { crabot_computer_use_token: caller } })
      expect(response.structuredContent).toMatchObject({ effect: 'unverifiable', verified: false, path: 'native', echoed: '中文😀' })
      expect(response.isError).toBe(false)
      const forged = await client.callTool({ name: 'type_text', arguments: { text: 'x', session: caller }, _meta: { crabot_computer_use_token: caller } })
      expect(forged.isError).toBe(true)
      grants.delete(caller)
      expect((await client.callTool({ name: 'type_text', arguments: { text: 'denied' }, _meta: { crabot_computer_use_token: caller } })).isError).toBe(true)
    }
    expect(new Set(sessions).size).toBe(4)
    expect(sessions).toHaveLength(4)
  })
})
