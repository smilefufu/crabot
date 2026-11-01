import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import nodeModule from 'node:module'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { ProxyManager } from './proxy-manager.js'

const proxyKeys = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'] as const
function systemFixture(t: TestContext, output: string, os = 'darwin') {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const environmentKeys = [...proxyKeys, 'CRABOT_PRODUCT_ROOT', 'CRABOT_HOME']
  const environment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]))
  const original = getGlobalDispatcher()
  for (const key of environmentKeys) delete process.env[key]
  Object.defineProperty(process, 'platform', { ...platform, value: os })
  const command = t.mock.method(childProcess, 'execFileSync', () => output)
  t.after(async () => {
    const current = getGlobalDispatcher(); setGlobalDispatcher(original)
    await current.destroy()
    Object.defineProperty(process, 'platform', platform)
    for (const key of environmentKeys) {
      if (environment[key] === undefined) delete process.env[key]
      else process.env[key] = environment[key]
    }
  })
  return command
}
function windowsFixture(t: TestContext, proxy: string | null, nativeFile = '../../crabot-native/build/Release/crabot-native.node') {
  systemFixture(t, '', 'win32')
  const read = t.mock.fn(() => proxy)
  t.mock.method(nodeModule, 'createRequire', () => ((file: string) => {
    assert.equal(file, nativeFile)
    return { readWindowsFixedProxy: read }
  }) as NodeJS.Require)
  return read
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

test('Linux retains the environment-only behavior', t => {
  const command = systemFixture(t, fixedProxy(), 'linux')
  const manager = new ProxyManager(); manager.updateConfig({ mode: 'system' })
  assert.equal(manager.getProxyUrl(), null)
  assert.equal(command.mock.callCount(), 0)
})

test('Windows reads a current-user fixed proxy once and rereads after saving system', t => {
  const read = windowsFixture(t, '127.0.0.1:7890')
  const manager = new ProxyManager(); manager.updateConfig({ mode: 'system' })
  assert.equal(manager.getProxyUrl(), 'http://127.0.0.1:7890')
  assert.equal(ProxyManager.resolveSystemProxyUrl(), 'http://127.0.0.1:7890')
  assert.equal(read.mock.callCount(), 1)
  read.mock.mockImplementation(() => '127.0.0.1:7891')
  assert.equal(manager.getProxyUrl(), 'http://127.0.0.1:7890')
  manager.updateConfig({ mode: 'system' })
  assert.equal(manager.getProxyUrl(), 'http://127.0.0.1:7891')
  assert.equal(read.mock.callCount(), 2)
})

test('saving system refreshes the CLI reader in a second Shared module copy', async t => {
  const read = windowsFixture(t, '127.0.0.1:7890')
  const { ProxyManager: CliProxyManager } = await import('./proxy-manager.js?proxy-refresh-regression')
  const admin = new ProxyManager(); admin.updateConfig({ mode: 'system' })
  assert.equal(CliProxyManager.resolveSystemProxyUrl(), 'http://127.0.0.1:7890')
  read.mock.mockImplementation(() => '127.0.0.1:7891')
  admin.updateConfig({ mode: 'system' })
  assert.equal(admin.getProxyUrl(), 'http://127.0.0.1:7891')
  assert.equal(CliProxyManager.resolveSystemProxyUrl(), 'http://127.0.0.1:7891')
})

test('Windows resolves the root helper when Shared is a copied production dependency', t => {
  const root = path.resolve('fixture-core')
  const read = windowsFixture(t, '127.0.0.1:7890', path.join(root, 'crabot-native/build/Release/crabot-native.node'))
  process.env.CRABOT_PRODUCT_ROOT = root
  process.env.CRABOT_HOME = path.resolve('unrelated-old-install')
  const manager = new ProxyManager(); manager.updateConfig({ mode: 'system' })
  assert.equal(manager.getProxyUrl(), 'http://127.0.0.1:7890')
  assert.equal(read.mock.callCount(), 1)
})

for (const [name, value, expected] of [
  ['HTTPS priority', 'http=http.example:8000;https=https.example:9000', 'http://https.example:9000'],
  ['HTTP fallback', 'ftp=ftp.example:21;http=http.example:8000', 'http://http.example:8000'],
  ['case-insensitive protocol', 'HTTPS=127.0.0.1:7890', 'http://127.0.0.1:7890'],
  ['default port', 'proxy.example', 'http://proxy.example'],
  ['HTTP URL', 'http://127.0.0.1:7890', 'http://127.0.0.1:7890'],
  ['IPv6', '[::1]:7890', 'http://[::1]:7890'],
  ['disabled or missing fixed proxy', null, null],
  ['empty fixed proxy', '', null],
  ['SOCKS only', 'socks=127.0.0.1:7890', null],
  ['FTP only', 'ftp=127.0.0.1:7890', null],
  ['invalid port', '127.0.0.1:65536', null],
  ['empty port', '127.0.0.1:', null],
  ['credentials', 'user:password@127.0.0.1:7890', null],
  ['path', 'http://127.0.0.1:7890/path', null],
] as const) {
  test(`Windows fixed proxy: ${name}`, t => {
    windowsFixture(t, value)
    const manager = new ProxyManager(); manager.updateConfig({ mode: 'system' })
    assert.equal(manager.getProxyUrl(), expected)
  })
}

test('Windows environment priority and custom/none do not read OS settings', t => {
  const read = windowsFixture(t, '127.0.0.1:7890')
  const manager = new ProxyManager()
  manager.updateConfig({ mode: 'none' }); assert.equal(manager.getProxyUrl(), null)
  manager.updateConfig({ mode: 'custom', custom_url: 'http://custom.example:8080' })
  assert.equal(manager.getProxyUrl(), 'http://custom.example:8080')
  // Windows aliases environment keys by case; test each spelling in isolation.
  for (const key of proxyKeys) {
    for (const existing of proxyKeys) delete process.env[existing]
    process.env[key] = `http://${key.toLowerCase().replace('_', '-')}.example:8000`
    manager.updateConfig({ mode: 'system' })
    assert.equal(manager.getProxyUrl(), process.env[key])
  }
  for (const key of proxyKeys) delete process.env[key]
  process.env.HTTP_PROXY = 'http://http.example:8000'
  process.env.HTTPS_PROXY = 'http://https.example:9000'
  manager.updateConfig({ mode: 'system' })
  assert.equal(manager.getProxyUrl(), 'http://https.example:9000')
  assert.equal(read.mock.callCount(), 0)
})

test('unavailable Windows native settings remain nonfatal and can be reread', t => {
  const read = windowsFixture(t, null)
  read.mock.mockImplementation(() => { throw new Error('fixture native read failure') })
  const manager = new ProxyManager()
  assert.doesNotThrow(() => manager.updateConfig({ mode: 'system' }))
  assert.equal(manager.getProxyUrl(), null)
  read.mock.mockImplementation(() => '127.0.0.1:7890')
  manager.updateConfig({ mode: 'system' })
  assert.equal(manager.getProxyUrl(), 'http://127.0.0.1:7890')
})

test('environment precedence and custom/none do not invoke macOS detection', t => {
  const command = systemFixture(t, fixedProxy())
  const manager = new ProxyManager()
  manager.updateConfig({ mode: 'none' }); assert.equal(manager.getProxyUrl(), null)
  manager.updateConfig({ mode: 'custom', custom_url: 'http://custom.example:8080' })
  assert.equal(manager.getProxyUrl(), 'http://custom.example:8080')
  // Windows aliases environment keys by case; test each spelling in isolation.
  for (const key of proxyKeys) {
    for (const existing of proxyKeys) delete process.env[existing]
    process.env[key] = `http://${key.toLowerCase().replace('_', '-')}.example:8000`
    manager.updateConfig({ mode: 'system' })
    assert.equal(manager.getProxyUrl(), process.env[key])
  }
  for (const key of proxyKeys) delete process.env[key]
  process.env.HTTP_PROXY = 'http://http.example:8000'
  process.env.HTTPS_PROXY = 'http://https.example:9000'
  manager.updateConfig({ mode: 'system' })
  assert.equal(manager.getProxyUrl(), 'http://https.example:9000')
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

for (const platform of ['darwin', 'win32']) test(`the detected ${platform} proxy carries actual fetch and HTTP Agent requests while loopback remains direct`, { timeout: 8000 }, async t => {
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
  if (platform === 'darwin') systemFixture(t, fixedProxy((proxy.address() as net.AddressInfo).port))
  else windowsFixture(t, `127.0.0.1:${(proxy.address() as net.AddressInfo).port}`)
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
