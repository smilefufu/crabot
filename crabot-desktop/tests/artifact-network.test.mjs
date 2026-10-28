import test from 'node:test'
import assert from 'node:assert/strict'
import { artifactUrl, attachArtifactNetwork } from '../dist/artifact-network.js'

const target = 'http://127.0.0.1:3000/api/media/a232f3cb-a297-440f-8aba-03af28359e36'
function fixture() {
  const hooks = {}, webRequest = {}
  for (const name of ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived', 'onCompleted', 'onErrorOccurred']) webRequest[name] = handler => { hooks[name] = handler }
  let scope = { instance_id: 'instance', generation: 'first', admin_url: 'http://127.0.0.1:3000', connection_epoch: 1 }
  const host = { context: () => scope, credential: async () => ({ ...scope, token: 'private-admin-token' }) }
  const policy = attachArtifactNetwork({ webRequest }, host, () => ({ id: 7 }), target, scope)
  const request = (id, extra = {}) => ({ id, method: 'GET', url: target, webContentsId: 7, resourceType: 'mainFrame', requestHeaders: {}, ...extra })
  const before = details => new Promise(resolve => hooks.onBeforeRequest(details, resolve))
  const headers = details => new Promise(resolve => hooks.onBeforeSendHeaders(details, resolve))
  return { policy, hooks, host, request, before, headers, change: extra => { scope = { ...scope, ...extra } } }
}

test('only current instance media UUID URLs are accepted, with no input credentials or query forwarding', () => {
  const context = { admin_url: 'http://127.0.0.1:3000' }
  assert.equal(artifactUrl(target + '?token=old#fragment', context), target)
  assert.equal(artifactUrl(target.replace('http://127.0.0.1:3000', 'app://crabot'), context), target)
  for (const value of [target.replace(':3000', ':3001'), target.replace('/media/', '/config/'), target + '/extra', target.replace('http://', 'http://user:password@')]) assert.equal(artifactUrl(value, context), null)
  assert.equal(artifactUrl(target, null), null)
})

test('only a single armed exact navigation receives authentication, and redirects cannot reuse it', async t => {
  const f = fixture(); t.after(f.policy.close)
  assert.equal((await f.before(f.request(1))).cancel, true)
  assert.equal(f.policy.arm('preview'), true)
  assert.equal(f.policy.arm('preview'), false)
  const first = f.request(2)
  assert.equal((await f.before(first)).cancel, false)
  assert.equal((await f.headers(first)).requestHeaders.Authorization, 'Bearer private-admin-token')
  assert.equal((await f.before(f.request(3))).cancel, true)
  assert.equal((await f.before({ ...first, url: 'https://external.example/' })).cancel, true)
  assert.equal((await f.headers({ ...first, url: target + '/redirect' })).cancel, true)
})

test('artifact scripts and subresources receive no token or ambient cookie, including same-URL fetches', async t => {
  const f = fixture(); t.after(f.policy.close)
  f.policy.arm('preview')
  const subresource = f.request(1, { resourceType: 'xhr', requestHeaders: { Authorization: 'script-secret', COOKIE: 'ambient' } })
  await f.before(subresource)
  assert.deepEqual((await f.headers(subresource)).requestHeaders, {})
  const navigation = f.request(2); await f.before(navigation)
  assert.equal((await f.headers(navigation)).requestHeaders.Authorization, 'Bearer private-admin-token')
  f.hooks.onCompleted(navigation)
  assert.equal((await f.before(f.request(3))).cancel, true)
})

test('old generation or connection lifetime is rejected before and during credential refresh', async t => {
  const f = fixture(); t.after(f.policy.close)
  f.policy.arm('download'); const download = f.request(1, { resourceType: 'other' }); await f.before(download)
  f.change({ connection_epoch: 2 })
  assert.equal((await f.headers(download)).cancel, true)
  assert.equal(f.policy.arm('preview'), false)
  const g = fixture(); t.after(g.policy.close)
  g.policy.arm('preview'); const request = g.request(1); await g.before(request)
  g.host.credential = async () => { g.change({ generation: 'second' }); return { ...g.host.context(), token: 'new-token' } }
  assert.equal((await g.headers(request)).cancel, true)
})

test('preview response has an opaque content sandbox; cleanup removes all hooks', async () => {
  const f = fixture()
  const result = await new Promise(resolve => f.hooks.onHeadersReceived({ resourceType: 'mainFrame', responseHeaders: { 'content-security-policy': ['sandbox allow-same-origin'] } }, resolve))
  assert.match(result.responseHeaders['Content-Security-Policy'][0], /sandbox allow-scripts;/)
  assert.doesNotMatch(result.responseHeaders['Content-Security-Policy'][0], /allow-same-origin/)
  f.policy.close(); assert.ok(Object.values(f.hooks).every(value => value === null))
})
