import { afterEach, describe, expect, it, vi } from 'vitest'
import { connect, createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComputerUseBridge } from '../src/computer-use/service'
import { requestComputerUse, type ComputerUseRequest } from '../src/computer-use/client'
import { ComputerUseCoordinator } from '../src/computer-use/coordinator'
import { NATIVE_TOOLS } from '../src/computer-use/types'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function endpoint() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'cu-ipc-'))
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }))
  return process.platform === 'win32' ? `\\\\.\\pipe\\cu-ipc-${randomUUID()}` : join(directory, 's.sock')
}

async function fixture(authorize = async (token: string) => token === 'catalog') {
  const tools = vi.fn(async () => NATIVE_TOOLS.map(name => ({ name,
    inputSchema: { type: 'object' as const, properties: { session: { type: 'string' } } },
  })))
  const coordinator = new ComputerUseCoordinator({ tools, async call() { return { content: [] } }, async close() {} }, authorize)
  const bridge = createComputerUseBridge(coordinator, authorize)
  const path = await endpoint()
  await new Promise<void>(resolve => bridge.server.listen(path, resolve))
  cleanup.push(async () => { bridge.close(); await coordinator.close() })
  return { path, tools }
}

function rawRequest(path: string, send: (socket: ReturnType<typeof connect>) => void) {
  const socket = connect(path)
  cleanup.push(() => socket.destroy())
  const response = new Promise<string>((resolve, reject) => {
    let data = ''
    socket.setEncoding('utf8')
    socket.setTimeout(1_000, () => socket.destroy(new Error('TEST_RESPONSE_TIMEOUT')))
    socket.on('connect', () => send(socket))
    socket.on('data', chunk => { data += chunk })
    socket.on('error', reject)
    socket.on('close', () => resolve(data))
  })
  return response
}

describe('computer-use local IPC framing', () => {
  it('responds to a fragmented UTF-8 request without waiting for the client to end', async () => {
    const authorize = vi.fn(async (token: string) => token === '中文😀')
    const { path } = await fixture(authorize)
    const frame = Buffer.from(JSON.stringify({ token: '中文😀', method: 'list' }) + '\n')
    const split = frame.indexOf(Buffer.from('中')) + 1
    const response = await rawRequest(path, socket => {
      socket.write(frame.subarray(0, split))
      setTimeout(() => socket.write(frame.subarray(split, frame.length - 1)), 10)
      setTimeout(() => {
        expect(authorize).not.toHaveBeenCalled()
        socket.write(frame.subarray(frame.length - 1))
      }, 20)
    })
    expect(JSON.parse(response).result.tools.map((tool: { name: string }) => tool.name)).toContain('perform_actions')
    expect(authorize).toHaveBeenCalledTimes(1)
  })

  it('keeps the client open while awaiting a delayed, fragmented response', async () => {
    const path = await endpoint()
    let endedBeforeResponse = false
    let replied = false
    const result = { tools: [{ name: '中文😀', description: 'x'.repeat(128_000) }] }
    const server = createServer({ allowHalfOpen: true }, socket => {
      cleanup.push(() => socket.destroy())
      socket.on('error', () => {})
      socket.once('end', () => { endedBeforeResponse = !replied })
      socket.once('data', () => setTimeout(() => {
        replied = true
        const frame = Buffer.from(JSON.stringify({ result }))
        const split = frame.indexOf(Buffer.from('中')) + 1
        socket.write(frame.subarray(0, split))
        setTimeout(() => socket.end(frame.subarray(split)), 10)
      }, 20))
    })
    await new Promise<void>(resolve => server.listen(path, resolve))
    cleanup.push(() => { server.close() })
    await expect(requestComputerUse(path, { token: 'catalog', method: 'list' })).resolves.toEqual(result)
    expect(endedBeforeResponse).toBe(false)
  })

  it.each([
    { token: 'catalog', method: 'list', allowed: true },
    { token: 'invalid', method: 'list', allowed: false },
    { token: 'catalog', method: 'invalid', allowed: false },
  ])('returns a response for token=$token method=$method', async ({ token, method, allowed }) => {
    const { path, tools } = await fixture()
    const response = requestComputerUse(path, { token, method } as ComputerUseRequest)
    if (allowed) {
      expect((await response).tools).toHaveLength(NATIVE_TOOLS.length + 1)
      expect(tools).toHaveBeenCalledTimes(1)
    } else {
      await expect(response).rejects.toThrow('COMPUTER_USE_FORBIDDEN')
      expect(tools).not.toHaveBeenCalled()
    }
  })

  it('dispatches only once when more data arrives during authorization', async () => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const authorize = vi.fn(async () => { await waiting; return true })
    const { path, tools } = await fixture(authorize)
    const response = rawRequest(path, socket => {
      socket.write(JSON.stringify({ token: 'catalog', method: 'list' }) + '\n')
      setTimeout(() => { socket.write('\n'); release() }, 20)
    })
    expect(JSON.parse(await response).result.tools).toHaveLength(NATIVE_TOOLS.length + 1)
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(tools).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed JSON before invoking the coordinator', async () => {
    const { path, tools } = await fixture()
    const response = await rawRequest(path, socket => socket.write('{broken}\n'))
    expect(JSON.parse(response).error).toBeTypeOf('string')
    expect(tools).not.toHaveBeenCalled()
  })

  it('retains the request size limit without invoking the coordinator', async () => {
    const { path, tools } = await fixture()
    await expect(rawRequest(path, socket => socket.write('x'.repeat(1_000_001)))
      .catch(error => error.code)).resolves.toMatch(/^(|EPIPE|ECONNRESET)$/)
    expect(tools).not.toHaveBeenCalled()
  })

  it('retains the response size limit', async () => {
    const path = await endpoint()
    const server = createServer(socket => {
      cleanup.push(() => socket.destroy())
      socket.on('error', () => {})
      socket.once('data', () => socket.end('x'.repeat(24 * 1024 * 1024 + 1)))
    })
    await new Promise<void>(resolve => server.listen(path, resolve))
    cleanup.push(() => { server.close() })
    await expect(requestComputerUse(path, { token: 'catalog', method: 'list' }))
      .rejects.toThrow('COMPUTER_USE_BRIDGE_LIMIT')
  })

  it('preserves the cancellation error while authorization is pending', async () => {
    const controller = new AbortController()
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const { path, tools } = await fixture(async () => { controller.abort(); await waiting; return false })
    try {
      await expect(requestComputerUse(path, { token: 'catalog', method: 'list' }, controller.signal))
        .rejects.toThrow('COMPUTER_USE_CANCELLED_UNKNOWN')
      expect(tools).not.toHaveBeenCalled()
    } finally { release() }
  })

  it('retains the client timeout when the server never replies', async () => {
    const path = await endpoint()
    let accepted!: () => void
    const connected = new Promise<void>(resolve => { accepted = resolve })
    const server = createServer(socket => { cleanup.push(() => socket.destroy()); socket.on('error', () => {}); accepted() })
    await new Promise<void>(resolve => server.listen(path, resolve))
    cleanup.push(() => { server.close() })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const request = expect(requestComputerUse(path, { token: 'catalog', method: 'list' }))
        .rejects.toThrow('COMPUTER_USE_BRIDGE_TIMEOUT')
      await connected
      await vi.advanceTimersByTimeAsync(65_000)
      await request
    } finally { vi.useRealTimers() }
  })
})
