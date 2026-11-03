// Run in a child process so an unhandled SDK rejection is a real nonzero exit.
// HTTP is replaced locally; the SDK's request handling and reconnect timers are real.
import { SocketModeClient } from '@slack/socket-mode'

const scenario = process.argv[2]
const logger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel() { return 'error' }, setName() {} }
let requests = 0, recovered = false, terminal = false
const client = new SocketModeClient({ appToken: 'xapp-fixture', logger, clientPingTimeout: scenario === 'stop' ? 50 : 1,
  clientOptions: { retryConfig: { retries: 0 }, fetch: async () => {
    requests++
    if (scenario === 'startup' || (scenario === 'transient' && requests === 2)) throw new TypeError('fetch failed', { cause: Object.assign(new Error('fixture TLS reset'), { code: 'ECONNRESET' }) })
    return new Response(JSON.stringify(scenario === 'permanent' && requests > 1 ? { ok: false, error: 'invalid_auth' } : { ok: true, url: 'wss://local-fixture.invalid' }), { status: 200 })
  } } })
// Isolate reconnect control flow from WebSocket transport (covered by the HTTPS proxy test).
client.start = async function () {
  const url = await this.retrieveWSSURL()
  recovered = true
  this.emit('connected', { url })
}
client.on('error', () => {})
client.on('disconnected', () => { terminal = true })
const deadline = setTimeout(() => { console.error('SDK reconnect fixture deadline'); process.exit(2) }, 3000)
if (scenario === 'startup') {
  try { await client.start(); process.exit(3) }
  catch (error) {
    clearTimeout(deadline)
    console.log(JSON.stringify({ requests, recovered, terminal, startupError: error.code }))
  }
  process.exit(0)
}
// A successful control-plane handshake precedes the simulated established-session close.
await client.retrieveWSSURL()
client.on('connected', async () => {
  await client.disconnect()
  clearTimeout(deadline)
  console.log(JSON.stringify({ requests, recovered, terminal }))
})
if (scenario === 'permanent') client.on('disconnected', () => {
  clearTimeout(deadline)
  console.log(JSON.stringify({ requests, recovered, terminal }))
})
client.emit('close')
if (scenario === 'stop') {
  await client.disconnect()
  await new Promise(resolve => setTimeout(resolve, 100))
  clearTimeout(deadline)
  console.log(JSON.stringify({ requests, recovered, terminal }))
}
