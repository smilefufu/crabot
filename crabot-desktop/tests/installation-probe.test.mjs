import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

test('actual Linux main keeps the installation renderer sandboxed when profile I/O finishes after ready', { skip: process.platform !== 'linux', timeout: 45000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-installation-probe-'))), profile = path.join(root, 'profile')
  await fs.mkdir(profile, { mode: 0o700 })
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const token = randomBytes(32).toString('hex'); let received = false
  const server = createServer((request, response) => {
    if (request.url !== '/' + token + '/gui') { response.writeHead(404).end(); return }
    received = true; response.setHeader('Content-Type', 'text/html')
    response.end('<!doctype html><title>Crabot sandbox probe</title><body data-ready="yes">finite installation probe</body>')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const target = `http://127.0.0.1:${server.address().port}/${token}/gui`
  const keep = new Set(['PATH', 'HOME', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL', 'LC_CTYPE'])
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => keep.has(name)))
  env.CRABOT_TEST_INSTALLATION_PROFILE = profile
  const result = await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('./installation-probe-delayed-entry.mjs', import.meta.url)),
      '--enable-sandbox', '--user-data-dir=' + profile, '--installation-sandbox-probe=' + target], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 40000 })
    let output = ''
    const append = bytes => { output = (output + bytes.toString()).slice(-16384) }
    child.stdout.on('data', append); child.stderr.on('data', append)
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output }))
  })
  assert.match(result.output, /CRABOT_INSTALL_PROBE_PROFILE_AFTER_READY/)
  assert.equal(result.code, 0, result.output); assert.equal(received, true)
  await assert.rejects(fs.lstat(path.join(root, 'mm.pid')), { code: 'ENOENT' })
})
