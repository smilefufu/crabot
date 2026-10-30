import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import test, { type TestContext } from 'node:test'
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { ProxyManager } from './proxy-manager.js'

const proxyKeys = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'] as const
function systemFixture(t: TestContext, output: string) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const environment = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]))
  const original = getGlobalDispatcher()
  for (const key of proxyKeys) delete process.env[key]
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  const command = t.mock.method(childProcess, 'execFileSync', () => output)
  t.after(async () => {
    const current = getGlobalDispatcher(); setGlobalDispatcher(original)
    await current.destroy()
    Object.defineProperty(process, 'platform', platform)
    for (const key of proxyKeys) {
      if (environment[key] === undefined) delete process.env[key]
      else process.env[key] = environment[key]
    }
  })
  return command
}
const fixedProxy = (port = 7890) => `<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : ${port}\n}`

test('system mode discovers the macOS fixed proxy without shell variables and caches it until reapplied', t => {
  const command = systemFixture(t, fixedProxy())
  const manager = new ProxyManager()
  manager.updateConfig({ mode: 'system' })
  assert.equal(manager.getProxyUrl(), 'http://127.0.0.1:7890')
  assert.equal(ProxyManager.resolveSystemProxyUrl(), 'http://127.0.0.1:7890')
  manager.getHttpsAgent(); manager.getProxyUrl()
  assert.equal(command.mock.callCount(), 1)
  const args = command.mock.calls[0].arguments as unknown as [string, string[], { timeout: number; maxBuffer: number; shell?: boolean }]
  assert.equal(args[0], '/usr/sbin/scutil'); assert.deepEqual(args[1], ['--proxy'])
  assert.ok(args[2].timeout > 0 && args[2].timeout <= 3000)
  assert.ok(args[2].maxBuffer <= 65536); assert.notEqual(args[2].shell, true)
  command.mock.mockImplementation(() => fixedProxy(7891))
  assert.equal(manager.getProxyUrl(), 'http://127.0.0.1:7890')
  manager.updateConfig({ mode: 'system' })
  assert.equal(manager.getProxyUrl(), 'http://127.0.0.1:7891')
  assert.equal(command.mock.callCount(), 2)
})

test('Windows and Linux retain the environment-only behavior', t => {
  const command = systemFixture(t, fixedProxy())
  const manager = new ProxyManager()
  for (const platform of ['win32', 'linux']) {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    manager.updateConfig({ mode: 'system' })
    assert.equal(manager.getProxyUrl(), null)
  }
  assert.equal(command.mock.callCount(), 0)
})

test('environment precedence and custom/none do not invoke macOS detection', t => {
  const command = systemFixture(t, fixedProxy())
  const manager = new ProxyManager()
  manager.updateConfig({ mode: 'none' }); assert.equal(manager.getProxyUrl(), null)
  manager.updateConfig({ mode: 'custom', custom_url: 'http://custom.example:8080' })
  assert.equal(manager.getProxyUrl(), 'http://custom.example:8080')
  for (const key of [...proxyKeys].reverse()) {
    process.env[key] = `http://${key.toLowerCase().replace('_', '-')}.example:8000`
    manager.updateConfig({ mode: 'system' })
    assert.equal(manager.getProxyUrl(), process.env[key])
  }
  assert.equal(command.mock.callCount(), 0)
})

for (const [name, output, expected] of [
  ['HTTP fallback', '<dictionary> {\n HTTPEnable : 1\n HTTPProxy : localhost\n HTTPPort : 7890\n}', 'http://localhost:7890'],
  ['HTTPS priority', '<dictionary> {\n HTTPEnable : 1\n HTTPProxy : http.example\n HTTPPort : 8000\n HTTPSEnable : 1\n HTTPSProxy : https.example\n HTTPSPort : 9000\n}', 'http://https.example:9000'],
  ['IPv6', '<dictionary> {\n HTTPSEnable : 1\n HTTPSProxy : ::1\n HTTPSPort : 7890\n}', 'http://[::1]:7890'],
  ['disabled', '<dictionary> {\n HTTPSEnable : 0\n HTTPSProxy : localhost\n HTTPSPort : 7890\n}', null],
  ['nested interface only', '<dictionary> {\n __SCOPED__ : <dictionary> {\n en0 : <dictionary> {\n HTTPSEnable : 1\n HTTPSProxy : localhost\n HTTPSPort : 7890\n }\n }\n}', null],
  ['invalid port', fixedProxy(65536), null],
  ['invalid host', '<dictionary> {\n HTTPSEnable : 1\n HTTPSProxy : user:password@localhost\n HTTPSPort : 7890\n}', null],
  ['PAC only', '<dictionary> {\n ProxyAutoConfigEnable : 1\n ProxyAutoConfigURLString : https://example.invalid/proxy.pac\n}', null],
] as const) {
  test(`macOS parsing: ${name}`, t => {
    systemFixture(t, output)
    const manager = new ProxyManager(); manager.updateConfig({ mode: 'system' })
    assert.equal(manager.getProxyUrl(), expected)
  })
}

test('failed native reads remain nonfatal and can be retried by saving system', t => {
  const command = systemFixture(t, '')
  command.mock.mockImplementation(() => { throw new Error('fixture native failure') })
  const manager = new ProxyManager()
  assert.doesNotThrow(() => manager.updateConfig({ mode: 'system' }))
  assert.equal(manager.getProxyUrl(), null)
  command.mock.mockImplementation(() => fixedProxy())
  manager.updateConfig({ mode: 'system' })
  assert.equal(manager.getProxyUrl(), 'http://127.0.0.1:7890')
})

test('the detected proxy carries actual fetch and HTTP Agent requests while loopback remains direct', { timeout: 8000 }, async t => {
  const endpoint = http.createServer((_req, res) => { res.end('fixture-response') })
  const sockets = new Set<net.Socket>(), tunnels: string[] = []
  const proxy = http.createServer()
  for (const server of [endpoint, proxy]) server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve))
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const endpointPort = (endpoint.address() as net.AddressInfo).port
  proxy.on('connect', (req, socket, head) => {
    tunnels.push(req.url!)
    const upstream = net.connect(endpointPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream))
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy())
  })
  t.after(async () => { for (const socket of sockets) socket.destroy(); await Promise.all([endpoint, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve())))) })
  systemFixture(t, fixedProxy((proxy.address() as net.AddressInfo).port))
  const manager = new ProxyManager(); manager.updateConfig({ mode: 'system' })
  assert.equal(await (await fetch('http://proxy-fixture.invalid/fetch', { signal: AbortSignal.timeout(2000) })).text(), 'fixture-response')
  const agentBody = await new Promise<string>((resolve, reject) => {
    http.get('http://proxy-fixture.invalid/agent', { agent: manager.getHttpsAgent() }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', value => { body += value }); res.on('end', () => resolve(body))
    }).on('error', reject)
  })
  assert.equal(agentBody, 'fixture-response')
  const before = tunnels.length
  assert.equal(await (await fetch(`http://127.0.0.1:${endpointPort}/direct`)).text(), 'fixture-response')
  assert.equal(tunnels.length, before)
  assert.deepEqual(tunnels, ['proxy-fixture.invalid:80', 'proxy-fixture.invalid:80'])
  manager.getHttpsAgent().destroy()
})
