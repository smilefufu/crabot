import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import controlReader from './full-host-transport.cjs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { Readable, PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'

// Exercise only the fixture's control transport with Windows-style EOF stdin.
// No product app, auth handler, MM or renderer is replaced or launched.
test('full-host fixture receives controls despite EOF stdin and removes transport secrets before module launch', { timeout: 5000 }, async () => {
  const sockets = new Set(), output = []
  let connected
  const connection = new Promise(resolve => { connected = resolve })
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    controlReader(socket).once('line', token => { assert.equal(token, 'fixture-token'); connected(socket) })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const app = new EventEmitter()
  const window = { visible: true, close() { this.visible = false }, isVisible() { return this.visible },
    webContents: { getURL: () => 'app://crabot/', isLoadingMainFrame: () => false,
      executeJavaScript: async code => code.startsWith('({node:') ? { node: 'undefined', token: null }
        : { phase: 'ready', generation: 'fixture-generation' } } }
  const env = { CRABOT_FULL_HOST_FIXTURE: '1', NODE_OPTIONS: 'test-only',
    CRABOT_FULL_HOST_CONTROL_PORT: String(server.address().port), CRABOT_FULL_HOST_CONTROL_TOKEN: 'fixture-token' }
  const require = createRequire(import.meta.url)
  try {
    const script = await readFile(new URL('./full-host-preload.cjs', import.meta.url), 'utf8')
    runInNewContext(script, { process: { versions: { electron: '44.9.0' }, env, stdin: Readable.from([]),
      stdout: { write: value => output.push(JSON.parse(value.slice('CRABOT_FULL_HOST '.length))) } },
    require: name => name === 'electron' ? { app, dialog: {}, BrowserWindow: { getAllWindows: () => [window] } } : require(name),
    setImmediate, setTimeout })
    const socket = await connection
    socket.write('close\n')
    const deadline = Date.now() + 2000
    while (!output.some(event => event.tag === 'close') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(output.some(event => event.tag === 'fixture_error'), false)
    assert.deepEqual(output.find(event => event.tag === 'close'), { tag: 'close', phase: 'ready', generation: 'fixture-generation', visible: false })
    assert.equal(env.NODE_OPTIONS, undefined)
    assert.equal(env.CRABOT_FULL_HOST_CONTROL_PORT, undefined)
    assert.equal(env.CRABOT_FULL_HOST_CONTROL_TOKEN, undefined)
  } finally {
    app.emit('will-quit')
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
})

test('the fixture socket owner handles resets without a second unhandled readline error', () => {
  const input = new PassThrough(), errors = []
  input.on('error', error => errors.push(error.code))
  const reader = controlReader(input)
  try {
    assert.doesNotThrow(() => input.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })))
    assert.deepEqual(errors, ['ECONNRESET'])
  } finally { reader.close(); input.destroy() }
})
