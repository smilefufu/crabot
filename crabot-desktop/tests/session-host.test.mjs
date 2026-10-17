import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { SessionHost } from '../dist/session-host.js'

async function fixture(t, open) {
  const root = await mkdtemp(join(tmpdir(), 'crabot-host-state-'))
  await mkdir(join(root, 'scripts/lib'), { recursive: true })
  // Host state-machine fixture only; actual OS-peer bootstrap is tested separately.
  const key = '__crabot_host_fixture_' + root.split(/[\\/]/).at(-1)
  globalThis[key] = open
  await writeFile(join(root, 'scripts/lib/desktop-session-client.mjs'), `export const openDesktopSession=()=>globalThis[${JSON.stringify(key)}]()`)
  const host = new SessionHost({ coreRoot: root, dataRoot: root, appVersion: 'fixture', platform: process.platform })
  t.after(async () => { host.close(); delete globalThis[key]; await rm(root, { recursive: true, force: true }) })
  return host
}
const response = origin => ({ type: 'session', protocol_version: 1, instance_id: 'a'.repeat(64), generation: 'b232f3cb-a297-440f-8aba-03af28359e36',
  admin_url: origin, token: 'fixture-main-only', expires_at: new Date(Date.now() + 15 * 60_000 - 1000).toISOString() })

test('main keeps credentials private and checks current server-side authentication with a bounded direct read', async t => {
  let revoked = false, requests = 0
  const server = createServer((req, res) => {
    requests++; assert.equal(req.url, '/api/auth/me'); assert.equal(req.headers.authorization, 'Bearer fixture-main-only')
    res.writeHead(revoked ? 401 : 200).end(JSON.stringify(revoked ? { error: 'Unauthorized' } : { is_temp: false, password_configured: false, auth_method: 'desktop' }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const host = await fixture(t, () => response(`http://127.0.0.1:${server.address().port}`))
  await host.reconnect()
  assert.equal(JSON.stringify(host.snapshot()).includes('fixture-main-only'), false)
  assert.equal((await host.credential()).token, 'fixture-main-only')
  assert.equal(await host.check(), true)
  revoked = true
  assert.equal(await host.check(), false)
  assert.equal(host.snapshot().phase, 'disconnected')
  assert.equal(await host.credential(), null)
  assert.equal(requests, 2)
})

test('a delayed bootstrap cannot resurrect a stopped or closed host', async t => {
  let finish, started
  const opening = new Promise(resolve => { started = resolve })
  const host = await fixture(t, () => { started(); return new Promise(resolve => { finish = resolve }) })
  const pending = host.reconnect()
  await opening
  host.status('stopping')
  finish(response('http://127.0.0.1:3000'))
  await pending
  assert.equal(host.snapshot().phase, 'stopping')
  assert.equal(await host.credential(), null)
  host.close()
  await host.reconnect()
  assert.equal(await host.credential(), null)
})
