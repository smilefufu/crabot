import test from 'node:test'
import assert from 'node:assert/strict'
import { attachDesktopNetwork } from '../dist/desktop-network.js'

function fixture() {
  const hooks = {}, webRequest = {}
  for (const name of ['onBeforeRequest', 'onBeforeSendHeaders', 'onCompleted', 'onErrorOccurred']) webRequest[name] = handler => { hooks[name] = handler }
  const frame = { parent: null, origin: 'app://crabot', url: 'app://crabot/chat', processId: 11, routingId: 2 }
  const contents = { id: 7, mainFrame: frame, isDestroyed: () => false }
  let scope = { instance_id: 'instance', generation: 'first', admin_url: 'http://127.0.0.1:3000' }, renewals = 0
  const host = { context: () => scope, credential: async () => ({ ...scope, token: 'private-admin-token' }), reconnect: async () => { renewals++ } }
  const close = attachDesktopNetwork({ webRequest }, host, () => contents)
  const request = (id, extra = {}) => ({ id, method: 'GET', url: 'http://127.0.0.1:3000/api/auth/me',
    webContentsId: 7, initiatorOrigin: 'app://crabot', frame, requestHeaders: {}, ...extra })
  const before = details => hooks.onBeforeRequest(details, () => {})
  const headers = details => new Promise(resolve => hooks.onBeforeSendHeaders(details, resolve))
  return { hooks, host, frame, close, request, before, headers, setScope: value => { scope = value }, getScope: () => scope, renewals: () => renewals }
}

test('only the trusted top frame receives a header; external URLs and subframes never receive the Admin token', async t => {
  const f = fixture(); t.after(f.close)
  const good = f.request(1); f.before(good)
  assert.equal((await f.headers(good)).requestHeaders.Authorization, 'Bearer private-admin-token')
  for (const [id, extra] of [[2, { frame: { ...f.frame, parent: f.frame } }], [3, { initiatorOrigin: 'https://external.example' }],
    [4, { webContentsId: 8 }], [5, { frame: { ...f.frame, routingId: 99 } }], [6, { frame: { ...f.frame, url: 'about:blank' } }],
    [7, { initiatorOrigin: undefined }]]) {
    const request = f.request(id, extra); f.before(request)
    assert.equal((await f.headers(request)).cancel, true)
  }
  const external = f.request(8, { url: 'https://external.example/', requestHeaders: { AUTHORIZATION: 'renderer-supplied-secret' } })
  f.before(external)
  assert.deepEqual((await f.headers(external)).requestHeaders, {})
})

test('a request captured before generation change cannot obtain the new generation token, including during refresh', async t => {
  const f = fixture(); t.after(f.close)
  const first = f.request(1); f.before(first)
  f.setScope({ ...f.getScope(), generation: 'second' })
  assert.equal((await f.headers(first)).cancel, true)
  const second = f.request(2); f.before(second)
  f.host.credential = async () => { f.setScope({ ...f.getScope(), generation: 'third' }); return { ...f.getScope(), token: 'new-private-token' } }
  assert.equal((await f.headers(second)).cancel, true)
})

test('redirects preserve the original request scope; preflight is public and credential-free', async t => {
  const f = fixture(); t.after(f.close)
  const external = f.request(1, { url: 'https://external.example/' }); f.before(external)
  const redirected = f.request(1); f.before(redirected)
  assert.equal((await f.headers(redirected)).cancel, true)
  const admin = f.request(2); f.before(admin)
  assert.deepEqual((await f.headers({ ...admin, url: 'https://external.example/', requestHeaders: { authorization: 'old-secret' } })).requestHeaders, {})
  const preflight = f.request(3, { method: 'OPTIONS', frame: null, initiatorOrigin: undefined, requestHeaders: { Authorization: 'old-secret' } })
  f.before(preflight)
  assert.deepEqual((await f.headers(preflight)).requestHeaders, {})
})

test('only current scoped 401 triggers session renewal, and cleanup detaches every listener', t => {
  const f = fixture()
  const first = f.request(1); f.before(first)
  f.hooks.onCompleted({ ...first, statusCode: 401 })
  assert.equal(f.renewals(), 1)
  const old = f.request(2); f.before(old); f.setScope({ ...f.getScope(), generation: 'new' })
  f.hooks.onCompleted({ ...old, statusCode: 401 })
  assert.equal(f.renewals(), 1)
  f.close()
  assert.ok(Object.values(f.hooks).every(value => value === null))
})
