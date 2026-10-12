import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createComputerUseServer } from '../src/computer-use/server'
import { createComputerUseBridge } from '../src/computer-use/service'
import { ComputerUseCoordinator } from '../src/computer-use/coordinator'
import { NATIVE_TOOLS, type NativeDriver } from '../src/computer-use/types'

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
  it('recovers the same MCP connection and bridge for all live callers with fresh native sessions', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'cu-wire-recovery-'))
    cleanup.push(() => fs.rm(directory, { recursive: true, force: true }))
    const grants = new Set(['manager', 'builtin', 'claude-code', 'codex'])
    const calls: Array<{ generation: number; name: string; session: unknown }> = []
    const available: boolean[] = []
    let oldExited = false
    let creations = 0
    function native(generation: number): NativeDriver {
      return {
        async tools() { return NATIVE_TOOLS.map(name => ({ name, inputSchema: { type: 'object', properties: {
          session: { type: 'string' }, text: { type: 'string' }, element_token: { type: 'string' },
        }, additionalProperties: false } })) },
        async call(name, args) {
          calls.push({ generation, name, session: args.session })
          if (generation === 0 && name === 'type_text') throw new Error('native disconnected')
          return { content: [], structuredContent: { effect: 'unverifiable', elements: [{ element_token: `element-${generation}` }] } }
        },
        async close() { if (generation === 0) oldExited = true },
      }
    }
    const coordinator = new ComputerUseCoordinator(native(0), async caller => grants.has(caller), async () => {
      expect(oldExited).toBe(true)
      creations++
      return native(1)
    }, value => available.push(value))
    const bridge = createComputerUseBridge(coordinator, async (caller, method) => method === 'list' ? caller === 'catalog' || grants.has(caller) : grants.has(caller))
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\cu-recovery-${Date.now()}` : join(directory, 's.sock')
    await new Promise<void>(done => bridge.server.listen(endpoint, done))
    cleanup.push(async () => { bridge.close(); await coordinator.close() })
    process.env.CRABOT_COMPUTER_USE_ENDPOINT = endpoint
    process.env.CRABOT_COMPUTER_USE_TOKEN = 'catalog'
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createComputerUseServer()
    const client = new Client({ name: 'recovery-test', version: 'test' })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    cleanup.push(() => client.close())
    const call = (caller: string, name: string, args = {}) => client.callTool({ name, arguments: args, _meta: { crabot_computer_use_token: caller } })
    for (const caller of grants) expect((await call(caller, 'get_window_state')).isError).toBe(false)
    const oldSessions = calls.filter(call => call.name === 'get_window_state').map(call => call.session)
    expect((await call('manager', 'type_text', { text: 'interrupted once' })).isError).toBe(true)
    expect(available).toEqual([false])
    grants.delete('builtin')
    await coordinator.revoke('builtin')
    expect((await call('builtin', 'get_window_state')).isError).toBe(true)
    expect(creations).toBe(0)
    expect((await call('manager', 'get_window_state')).isError).toBe(false)
    expect(creations).toBe(1)
    expect(available).toEqual([false, true])
    expect((await call('manager', 'click', { element_token: 'element-0' })).isError).toBe(true)
    for (const caller of ['claude-code', 'codex']) {
      expect((await call(caller, 'type_text', { text: 'before fresh observation' })).isError).toBe(true)
      expect((await call(caller, 'get_window_state')).isError).toBe(false)
      expect((await call(caller, 'type_text', { text: 'new explicit action' })).isError).toBe(false)
    }
    expect((await call('manager', 'type_text', { text: 'after another caller changed the desktop' })).isError).toBe(true)
    expect((await call('manager', 'get_window_state')).isError).toBe(false)
    expect((await call('manager', 'type_text', { text: 'new explicit action' })).isError).toBe(false)
    const newSessions = calls.filter(call => call.generation === 1 && call.name === 'get_window_state').map(call => call.session)
    expect(newSessions.every(session => !oldSessions.includes(session))).toBe(true)
    expect(new Set(newSessions).size).toBe(3)
    expect(calls.filter(call => call.generation === 0 && call.name === 'type_text')).toHaveLength(1)
    expect(calls.filter(call => call.generation === 1 && call.name === 'type_text')).toHaveLength(3)
    expect(creations).toBe(1)
  })

})
