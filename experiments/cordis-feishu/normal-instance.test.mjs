import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import control from '../../scripts/lib/runtime-control.cjs'
import identity from '../../scripts/lib/process-identity.cjs'
import { launchNormalFixture } from './normal-instance-fixture.mjs'

async function freePort() {
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}

test('normal managed Core main boots, serves and stops the real single-port instance', { timeout: 90_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-normal-cordis-'))
  const web = await freePort()
  const fixture = launchNormalFixture(directory, web)
  const { child, exited } = fixture
  let passed = false
  try {
    const [ready] = await fixture.ready
    assert.equal(ready.type, 'ready')
    const response = await fetch(`http://127.0.0.1:${web}/api/auth/me`)
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error, 'Unauthorized')
    assert.deepEqual(identity.listListeningTcpPorts(ready.pid), [])
    const ports = []
    for (const module of ready.modules) {
      const listening = identity.listListeningTcpPorts(module.pid)
      if (module.module_id === 'admin-web') assert.deepEqual(listening, [web])
      else assert.deepEqual(listening, [])
      ports.push(...listening)
    }
    assert.deepEqual(ports, [web])
    assert.ok(['healthy', 'degraded'].includes((await control.callRuntimeControl(directory,
      { target: 19339, source: 'fixture', method: 'health', params: {} }, { timeoutMs: 1500 })).status))
    child.kill('SIGTERM')
    const [code, signal] = await exited
    assert.equal(code, 0); assert.equal(signal, null)
    assert.equal((await fs.readdir(directory)).includes('instance-runtime.json'), false)
    passed = true
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited }
    if (passed) await fs.rm(directory, { recursive: true, force: true })
    else { await fs.writeFile(path.join(directory, 'fixture.log'), fixture.output()); console.log('Retained normal-instance diagnostics:', directory) }
  }
})
