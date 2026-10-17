// Real Electron window/Chromium fixture, no business MM, models or user data.
const { app, BrowserWindow, ipcMain, protocol, session } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createServer } = require('node:http')
const { once } = require('node:events')
const assert = require('node:assert/strict')
const { WebSocketServer } = require('../../crabot-admin/node_modules/ws')

app.setName('Crabot boundary fixture')
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const windows = [], servers = []
let root
async function main() {
  root = process.env.CRABOT_BOUNDARY_ROOT
  assert.ok(root && path.isAbsolute(root))
  await fs.mkdir(path.join(root, 'profile'), { recursive: true })
  app.setPath('userData', path.join(root, 'profile'))
  await app.whenReady()
  const module = file => import(pathToFileURL(path.join(__dirname, '../dist', file)).href)
  const { attachDesktopNetwork } = await module('desktop-network.js')
  const { attachLocalPages } = await module('local-pages.js')
  const { registerDesktopIpc } = await module('desktop-ipc.js')
  const { isTrustedFrame } = await module('window-security.js')
  const received = [], external = [], upgrades = []
  const websocket = new WebSocketServer({ noServer: true })
  async function listen(sink) {
    const server = createServer((req, res) => {
      sink.push({ url: req.url, authorization: req.headers.authorization })
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Crabot-Request-Id')
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
      if (req.url === '/redirect') { res.writeHead(302, { Location: externalOrigin + '/landing' }).end(); return }
      res.end(JSON.stringify({ ok: true }))
    })
    server.on('upgrade', (req, socket, head) => {
      upgrades.push({ url: req.url, authorization: req.headers.authorization })
      websocket.handleUpgrade(req, socket, head, client => { client.send('{"connected":true}'); client.close(1000) })
    })
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    return `http://127.0.0.1:${server.address().port}`
  }
  const externalOrigin = await listen(external), origin = await listen(received)
  const state = { phase: 'ready', app_version: 'fixture', platform: process.platform, instance_id: 'a'.repeat(64), generation: 'b232f3cb-a297-440f-8aba-03af28359e36', admin_url: origin }
  const host = { snapshot: () => state, context: () => ({ instance_id: state.instance_id, generation: state.generation, admin_url: origin }),
    credential: async () => ({ token: 'fixture-main-only', instance_id: state.instance_id, generation: state.generation, admin_url: origin }), reconnect: async () => {} }
  const privateSession = session.fromPartition('crabot-boundary')
  const web = path.join(root, 'web'); await fs.mkdir(web)
  await fs.writeFile(path.join(web, 'index.html'), '<!doctype html><html><meta charset="utf-8"><title>Crabot fixture</title><body>本地窗口边界夹具</body></html>')
  attachLocalPages(privateSession, web)
  const makeWindow = () => {
    const window = new BrowserWindow({ show: false, webPreferences: { session: privateSession, preload: path.join(__dirname, '../dist/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
    windows.push(window); return window
  }
  const trusted = makeWindow(), foreign = makeWindow()
  attachDesktopNetwork(privateSession, host, () => trusted.webContents)
  let starts = 0
  registerDesktopIpc({ ipc: ipcMain, contents: () => trusted.webContents,
    controller: { host, start: async () => { starts++; return state }, stop: async () => state, reconnect: async () => state },
    quit: async () => true, revealData: async () => true, openExternal: async () => {} })
  await trusted.loadURL('app://crabot/'); await foreign.loadURL('app://crabot/')
  assert.equal(isTrustedFrame(trusted.webContents.mainFrame, trusted.webContents), true)
  assert.equal(await trusted.webContents.executeJavaScript('typeof window.require'), 'undefined')
  const surface = await trusted.webContents.executeJavaScript('(async()=>({state:await window.crabotDesktop.getState(), keys:Object.keys(window.crabotDesktop), localToken:localStorage.getItem("crabot_admin_token")}))()')
  assert.equal(surface.state.phase, 'ready'); assert.equal(JSON.stringify(surface).includes('fixture-main-only'), false)
  assert.equal(surface.localToken, null)
  await trusted.webContents.executeJavaScript('window.crabotDesktop.startService()')
  assert.equal(starts, 1)
  const rejected = await foreign.webContents.executeJavaScript('window.crabotDesktop.startService().then(()=>false,()=>true)')
  assert.equal(rejected, true); assert.equal(starts, 1)
  const result = await trusted.webContents.executeJavaScript(`fetch(${JSON.stringify(origin + '/api/probe')}).then(r=>r.json())`)
  assert.equal(result.ok, true)
  assert.equal(received.find(req => req.url === '/api/probe').authorization, 'Bearer fixture-main-only')
  const wsUrl = origin.replace('http:', 'ws:') + '/ws/chat'
  const wsResult = await trusted.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const socket=new WebSocket(${JSON.stringify(wsUrl)});socket.onmessage=event=>resolve(JSON.parse(event.data));socket.onerror=()=>reject(new Error('WS connection failed'))})`)
  assert.equal(wsResult.connected, true)
  assert.deepEqual(upgrades[0], { url: '/ws/chat', authorization: 'Bearer fixture-main-only' })
  const foreignRequest = await foreign.webContents.executeJavaScript(`fetch(${JSON.stringify(origin + '/api/foreign')}).then(()=>true,()=>false)`)
  assert.equal(foreignRequest, false); assert.equal(received.some(req => req.url === '/api/foreign'), false)
  await trusted.webContents.executeJavaScript(`fetch(${JSON.stringify(externalOrigin + '/external')}).then(r=>r.text())`)
  assert.equal(external.find(req => req.url === '/external').authorization, undefined)
  await trusted.webContents.executeJavaScript(`fetch(${JSON.stringify(origin + '/redirect')}).then(r=>r.text())`)
  assert.equal(external.find(req => req.url === '/landing').authorization, undefined)
  assert.equal(await trusted.webContents.executeJavaScript('window.crabotDesktop.openExternal("file:///etc/passwd")'), false)
  console.log('CRABOT_ELECTRON_BOUNDARY ' + JSON.stringify({ electron: process.versions.electron, node: process.versions.node,
    sandbox: true, isolated_preload: true, current_frame_ipc: true, direct_http_header: true, direct_ws_header: true, foreign_frame_denied: true, redirect_token_absent: true }))
}
main().then(() => cleanup(0), error => { console.error('Electron boundary fixture failed:', error); void cleanup(1) })
async function cleanup(code) {
  windows.forEach(window => { if (!window.isDestroyed()) window.destroy() })
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
  app.exit(code)
}
