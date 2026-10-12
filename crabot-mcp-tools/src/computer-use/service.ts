import { createServer, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createNativeDriver } from './native-driver.js'
import { ComputerUseCoordinator } from './coordinator.js'
import type { ComputerUseRequest } from './client.js'

type Authorize = (token: string, method: string) => Promise<boolean>

export function createComputerUseBridge(coordinator: ComputerUseCoordinator, authorize: Authorize) {
  const clients = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, socket => {
    clients.add(socket)
    const controller = new AbortController()
    socket.on('close', () => { clients.delete(socket); controller.abort() })
    socket.on('error', () => {})
    socket.setEncoding('utf8')
    socket.setTimeout(65_000, () => socket.destroy())
    let data = ''
    socket.on('data', chunk => { data += chunk; if (Buffer.byteLength(data) > 1_000_000) socket.destroy() })
    socket.on('end', () => { void (async () => {
      try {
        const request: ComputerUseRequest = JSON.parse(data)
        if (!request || typeof request.token !== 'string' || !['call', 'list'].includes(request.method)
          || !await authorize(request.token, request.method)) throw new Error('COMPUTER_USE_FORBIDDEN')
        const result = request.method === 'list' ? { tools: await coordinator.tools() }
          : await coordinator.call(request.token, request.name ?? '', request.args ?? {}, controller.signal)
        socket.end(JSON.stringify({ result }))
      } catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : 'COMPUTER_USE_FAILED' })) }
    })() })
  })
  return { server, close: () => { server.close(); for (const socket of clients) socket.destroy() } }
}

async function main(): Promise<void> {
  if (!process.send || !process.env.CRABOT_COMPUTER_USE_ROOT || !process.env.CRABOT_COMPUTER_USE_STATE_DIR) throw new Error('COMPUTER_USE_HOST_REQUIRED')
  const pending = new Map<string, (allowed: boolean) => void>()
  const authorize: Authorize = (token, method) => new Promise(done => {
    const id = randomUUID()
    const timer = setTimeout(() => { pending.delete(id); done(false) }, 5_000)
    pending.set(id, allowed => { clearTimeout(timer); done(allowed) })
    if (process.connected) process.send!({ type: 'authorize', id, token, method })
    else { clearTimeout(timer); pending.delete(id); done(false) }
  })
  process.on('message', (message: any) => {
    if (message?.type === 'authorized') { pending.get(message.id)?.(message.allowed === true); pending.delete(message.id) }
    if (message?.type === 'revoke' && typeof message.token === 'string') void coordinator?.revoke(message.token)
  })
  let coordinator: ComputerUseCoordinator | undefined
  let bridge: ReturnType<typeof createComputerUseBridge> | undefined
  let stopping = false
  let directory: string | undefined
  let finished = false
  async function stop(): Promise<void> {
    stopping = true
    if (!finished) return // Initialization owns cleanup until it returns.
    bridge?.close()
    for (const done of pending.values()) done(false)
    pending.clear()
    await coordinator?.close()
    if (directory) await fs.rm(directory, { recursive: true, force: true })
    process.exit(0)
  }
  const requestStop = () => { void stop().catch(error => { process.send?.({ type: 'unavailable', reason: error.message }) }) }
  process.on('disconnect', requestStop)
  process.on('SIGTERM', requestStop)
  try {
    directory = await fs.mkdtemp(join(tmpdir(), 'crabot-desktop-'))
    await fs.chmod(directory, 0o700)
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\crabot-desktop-${randomUUID()}` : join(directory, 'bridge.sock')
    coordinator = new ComputerUseCoordinator(await createNativeDriver(process.env.CRABOT_COMPUTER_USE_ROOT, process.env.CRABOT_COMPUTER_USE_STATE_DIR), token => authorize(token, 'call'))
    bridge = createComputerUseBridge(coordinator, authorize)
    await coordinator.tools()
    if (!stopping) {
      await new Promise<void>((done, fail) => { bridge!.server.once('error', fail); bridge!.server.listen(endpoint, done) })
      if (process.platform !== 'win32') await fs.chmod(endpoint, 0o600)
    }
    finished = true
    if (stopping) await stop()
    else process.send({ type: 'ready', endpoint })
  } catch (error) {
    finished = true
    bridge?.close()
    await coordinator?.close()
    if (directory) await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
}
if (require.main === module) void main().catch(error => { process.send?.({ type: 'unavailable', reason: error.message }); process.exitCode = 1 })
