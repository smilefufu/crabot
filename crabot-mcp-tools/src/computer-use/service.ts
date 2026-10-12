import { createServer, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createNativeDriver } from './native-driver.js'
import { ComputerUseCoordinator } from './coordinator.js'
import type { ComputerUseRequest } from './client.js'

async function main(): Promise<void> {
  if (!process.send || !process.env.CRABOT_COMPUTER_USE_ROOT) throw new Error('COMPUTER_USE_HOST_REQUIRED')
  const pending = new Map<string, (allowed: boolean) => void>()
  const authorize = (token: string, method: string): Promise<boolean> => new Promise(done => {
    const id = randomUUID()
    const timer = setTimeout(() => { pending.delete(id); done(false) }, 5_000)
    pending.set(id, allowed => { clearTimeout(timer); done(allowed) })
    process.send!({ type: 'authorize', id, token, method })
  })
  process.on('message', (message: any) => {
    if (message?.type === 'authorized') { pending.get(message.id)?.(message.allowed === true); pending.delete(message.id) }
  })
  const directory = await fs.mkdtemp(join(tmpdir(), 'crabot-desktop-'))
  await fs.chmod(directory, 0o700)
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\crabot-desktop-${randomUUID()}` : join(directory, 'bridge.sock')
  const coordinator = new ComputerUseCoordinator(await createNativeDriver(process.env.CRABOT_COMPUTER_USE_ROOT), token => authorize(token, 'call'))
  const clients = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, socket => {
    clients.add(socket); socket.on('close', () => clients.delete(socket)); socket.on('error', () => {})
    socket.setEncoding('utf8')
    let data = ''
    socket.setTimeout(65_000, () => socket.destroy())
    socket.on('data', chunk => { data += chunk; if (Buffer.byteLength(data) > 1_000_000) socket.destroy() })
    socket.on('end', () => { void (async () => {
      try {
        const request: ComputerUseRequest = JSON.parse(data)
        if (!request || typeof request.token !== 'string' || !['call', 'list'].includes(request.method)
          || !await authorize(request.token, request.method)) throw new Error('COMPUTER_USE_FORBIDDEN')
        const result = request.method === 'list' ? { tools: await coordinator.tools() }
          : await coordinator.call(request.token, request.name ?? '', request.args ?? {})
        socket.end(JSON.stringify({ result }))
      } catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : 'COMPUTER_USE_FAILED' })) }
    })() })
  })
  let stopping = false
  const stop = async () => {
    if (stopping) return; stopping = true
    server.close()
    for (const socket of clients) socket.destroy()
    for (const done of pending.values()) done(false)
    await coordinator.close()
    await fs.rm(directory, { recursive: true, force: true })
    process.exit(0)
  }
  process.on('disconnect', () => { void stop() })
  process.on('SIGTERM', () => { void stop() })
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(endpoint, done) })
  if (process.platform !== 'win32') await fs.chmod(endpoint, 0o600)
  await coordinator.tools()
  process.send({ type: 'ready', endpoint })
}
void main().catch(error => { process.send?.({ type: 'unavailable', reason: error.message }); process.exitCode = 1 })
