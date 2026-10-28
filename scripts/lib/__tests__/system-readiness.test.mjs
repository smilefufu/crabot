import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { probeSystemReadiness } from '../system-control.mjs'
import { probeMmHealthy } from '../mm-probe.mjs'

async function fixture(t) {
  const servers = [], calls = [], statuses = { mm: 'degraded', 'admin-web': 'degraded', 'crabot-agent': 'healthy', 'memory-default': 'healthy' }
  let modules
  const ports = {}
  for (const name of Object.keys(statuses)) {
    const server = createServer((request, response) => {
      request.resume(); calls.push({ name, method: request.method, url: request.url })
      if (request.url === '/list_modules' && name === 'mm') response.end(JSON.stringify({ success: true, data: { modules } }))
      else if (request.url === '/health') response.end(JSON.stringify({ success: statuses[name] !== 'failed-envelope', data: { status: statuses[name] === 'failed-envelope' ? 'healthy' : statuses[name] } }))
      else { response.statusCode = 404; response.end() }
    })
    servers.push(server)
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    ports[name] = server.address().port
  }
  t.after(() => Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))))
  modules = Object.keys(statuses).filter(name => name !== 'mm').map(module_id => ({ module_id, status: 'running', port: ports[module_id] }))
  return { modules, statuses, calls, ports, probe: () => probeSystemReadiness(ports.mm) }
}

test('an unconfigured first boot with live degraded management modules is operational without bypassing business gates', async t => {
  const f = await fixture(t)
  assert.equal(await probeMmHealthy(f.ports.mm), false, 'legacy strict MM predicate must keep its original meaning')
  assert.deepEqual(await f.probe(), { ready: true, health: 'degraded' })
  assert.equal(f.modules.every(module => module.last_health_status === undefined), true, 'fresh registered health must not await a 30-second MM cache tick')
  assert.equal(f.calls.every(call => call.method === 'POST' && ['/list_modules', '/health'].includes(call.url)), true)
  assert.equal(f.calls.some(call => call.url.includes('cutover') || call.url.includes('config')), false)
})

test('healthy manager and core modules report healthy; independent optional module degradation stays visible', async t => {
  const f = await fixture(t); f.statuses.mm = 'healthy'; f.statuses['admin-web'] = 'healthy'
  assert.deepEqual(await f.probe(), { ready: true, health: 'healthy' })
  f.statuses.mm = 'degraded'; f.modules.push({ module_id: 'optional-channel', status: 'error' })
  assert.deepEqual(await f.probe(), { ready: true, health: 'degraded' })
})

for (const state of ['unhealthy', 'failed-envelope', 'unknown']) test('unhealthy or unverified MM remains unavailable: ' + state, async t => {
  const f = await fixture(t); f.statuses.mm = state
  assert.deepEqual(await f.probe(), { ready: false, health: 'unhealthy' })
})

for (const changed of ['missing', 'stopped', 'error', 'unhealthy', 'unknown-health', 'invalid-port']) test('a required module cannot be inferred ready from the MM or stale cached health: ' + changed, async t => {
  const f = await fixture(t), agent = f.modules.find(module => module.module_id === 'crabot-agent')
  f.statuses.mm = 'healthy'; agent.last_health_status = 'healthy'
  if (changed === 'missing') f.modules.splice(f.modules.indexOf(agent), 1)
  if (changed === 'stopped') agent.status = 'stopped'
  if (changed === 'error') agent.status = 'error'
  if (changed === 'unhealthy') f.statuses['crabot-agent'] = 'unhealthy'
  if (changed === 'unknown-health') f.statuses['crabot-agent'] = 'unknown'
  if (changed === 'invalid-port') agent.port = 'not-a-port'
  assert.deepEqual(await f.probe(), { ready: false, health: 'unhealthy' })
})
