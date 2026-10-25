// Real Electron window/Chromium fixture, no business MM, models or user data.
const { app, BrowserWindow, ipcMain, nativeTheme, protocol, session } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createServer } = require('node:http')
const { createConnection } = require('node:net')
const { once } = require('node:events')
const assert = require('node:assert/strict')
const { WebSocketServer } = require('../../crabot-admin/node_modules/ws')

const started = Date.now()
const phase = value => console.log('CRABOT_BOUNDARY_PHASE ' + JSON.stringify({ phase: value, elapsed_ms: Date.now() - started }))
app.setName('Crabot boundary fixture')
// Async server cleanup owns the exit result, including an expected failed check.
app.on('window-all-closed', () => {})
app.on('child-process-gone', (_event, details) => {
  if (details.type === 'GPU') console.log('CRABOT_BOUNDARY_GPU_EXIT ' + JSON.stringify({ reason: details.reason, exit_code: details.exitCode, elapsed_ms: Date.now() - started }))
})
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const windows = [], servers = [], clients = new Set(), connections = new Set()
let releaseStreamEnded
const releaseStreamClosed = new Promise(resolve => { releaseStreamEnded = resolve })
let root
async function main() {
  root = process.env.CRABOT_BOUNDARY_ROOT
  assert.ok(root && path.isAbsolute(root))
  await fs.mkdir(path.join(root, 'profile'), { recursive: true })
  app.setPath('userData', path.join(root, 'profile'))
  await app.whenReady()
  phase('app-ready')
  if (process.env.CRABOT_BOUNDARY_PARENT_STALL === '1') { phase('parent-stall-ready'); await new Promise(() => {}); return }
  assert.throws(() => app.enableSandbox(), /before.*ready/i)
  console.log('CRABOT_ELECTRON_NATIVE_HOST loading Node-API helper in Electron ' + process.versions.electron)
  const identity = require('../../scripts/lib/process-identity.cjs')
  assert.equal(identity.inspectProcess(process.pid).pid, process.pid)
  assert.ok(identity.inspectProcessArguments(process.pid).length > 0)
  console.log('CRABOT_ELECTRON_NATIVE_HOST self identity and OS arguments verified')
  const module = file => import(pathToFileURL(path.join(__dirname, '../dist', file)).href)
  const { attachDesktopNetwork } = await module('desktop-network.js')
  const { attachLocalPages } = await module('local-pages.js')
  const { registerDesktopIpc } = await module('desktop-ipc.js')
  const { collectDiagnostics } = await module('diagnostics.js')
  const { ArtifactWindows } = await module('artifact-window.js')
  const { isTrustedFrame } = await module('window-security.js')
  const received = [], external = [], upgrades = []
  let wholeUi = false
  const websocket = new WebSocketServer({ noServer: true })
  async function listen(sink) {
    const server = createServer((req, res) => {
      sink.push({ url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie, method: req.method })
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Crabot-Request-Id')
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
      if (req.url === '/release-stall') { res.once('close', releaseStreamEnded); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }); res.write('first'); return }
      if (req.url === '/redirect') { res.writeHead(302, { Location: externalOrigin + '/landing' }).end(); return }
      if (req.url === '/api/media/a232f3cb-a297-440f-8aba-03af28359e36') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end('<!doctype html><title>Untrusted artifact fixture</title><body>附件预览<script>window.probe={bridge:typeof window.crabotDesktop,node:typeof require};fetch("/api/artifact-private-probe").catch(()=>{});</script></body>'); return
      }
      if (wholeUi) {
        const url = new URL(req.url, 'http://fixture')
        const body = url.pathname === '/api/model-config/global' ? { config: {} }
          : url.pathname === '/api/model-config/agents/crabot-agent' ? { config: null }
          : url.pathname === '/api/chat/messages' ? { messages: [] }
          : url.pathname === '/api/config/status' ? { configured: false, missing: ['尚未选择默认模型'], warnings: [] }
          : { items: [], pagination: { page: 1, page_size: 100, total_items: 0, total_pages: 1 } }
        res.end(JSON.stringify(body)); return
      }
      res.end(JSON.stringify({ ok: true }))
    })
    server.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)) })
    server.on('upgrade', (req, socket, head) => {
      upgrades.push({ url: req.url, authorization: req.headers.authorization })
      websocket.handleUpgrade(req, socket, head, client => {
        clients.add(client); client.on('close', () => clients.delete(client))
        if (wholeUi) client.send('{"type":"chat_message_acked","request_ids":[]}')
        else { client.send('{"connected":true}'); client.close(1000) }
      })
    })
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    return `http://127.0.0.1:${server.address().port}`
  }
  const externalOrigin = await listen(external), origin = await listen(received)
  if (process.env.CRABOT_BOUNDARY_HOLD_CONNECTION === '1') {
    const held = createConnection(Number(new URL(origin).port), '127.0.0.1')
    await once(held, 'connect'); phase('held-fixture-connection-ready')
  }
  const ready = { phase: 'ready', app_version: 'fixture', platform: process.platform, instance_id: 'a'.repeat(64), generation: 'b232f3cb-a297-440f-8aba-03af28359e36', admin_url: origin }
  let state = ready
  const context = () => state.phase === 'ready' ? { instance_id: state.instance_id, generation: state.generation, admin_url: origin, connection_epoch: 1 } : null
  const host = { snapshot: () => state, context, credential: async () => context() && ({ token: 'fixture-main-only', ...context() }), reconnect: async () => {} }
  const privateSession = session.fromPartition('crabot-boundary')
  const web = path.join(root, 'web'); await fs.mkdir(web)
  await fs.writeFile(path.join(web, 'desktop.html'), '<!doctype html><html><meta charset="utf-8"><title>Crabot fixture</title><body>本地窗口边界夹具</body></html>')
  attachLocalPages(privateSession, web)
  const makeWindow = () => {
    const window = new BrowserWindow({ width: 1180, height: 800, show: false, webPreferences: { session: privateSession, preload: path.join(__dirname, '../dist/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    const slot = windows.length
    window.webContents.on('render-process-gone', (_event, details) => console.log('CRABOT_BOUNDARY_RENDERER_EXIT ' + JSON.stringify({ slot, reason: details.reason, exit_code: details.exitCode, elapsed_ms: Date.now() - started })))
    window.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => console.log('CRABOT_BOUNDARY_LOAD_FAILURE ' + JSON.stringify({ slot, code, main_frame: mainFrame, elapsed_ms: Date.now() - started })))
    window.on('unresponsive', () => phase('window-unresponsive-' + slot))
    windows.push(window); return window
  }
  const trusted = makeWindow(), foreign = makeWindow()
  attachDesktopNetwork(privateSession, host, () => trusted.webContents)
  let starts = 0, updateDialogs = 0, directorySelections = 0
  const revealed = []
  let preview, exported, helpOpened
  const helpRequest = new Promise(resolve => { helpOpened = resolve })
  registerDesktopIpc({ ipc: ipcMain, contents: () => trusted.webContents,
    controller: { host, start: async () => { starts++; return state }, stop: async () => state, reconnect: async () => state },
    quit: async () => true, openUpdateDialog: async () => { updateDialogs++; return true }, revealData: async () => true, openExternal: async url => { helpOpened(url) },
    revealWorkspace: async id => { revealed.push(id); return true },
    selectWorkspace: async () => { directorySelections++; return root },
    diagnostics: async () => preview = await collectDiagnostics(path.join(__dirname, '../..'), state, []),
    exportDiagnostics: async id => { assert.equal(id, preview.report_id); exported = id; return false },
  })
  phase('local-frames-loading')
  await trusted.loadURL('app://crabot/'); await foreign.loadURL('app://crabot/')
  phase('local-frames-ready')
  assert.equal(isTrustedFrame(trusted.webContents.mainFrame, trusted.webContents), true)
  assert.equal(await trusted.webContents.executeJavaScript('typeof window.require'), 'undefined')
  const surface = await trusted.webContents.executeJavaScript('(async()=>({state:await window.crabotDesktop.getState(), keys:Object.keys(window.crabotDesktop), localToken:localStorage.getItem("crabot_admin_token")}))()')
  assert.equal(surface.state.phase, 'ready'); assert.equal(JSON.stringify(surface).includes('fixture-main-only'), false)
  assert.equal(surface.localToken, null)
  await trusted.webContents.executeJavaScript('window.crabotDesktop.startService()')
  assert.equal(starts, 1)
  const rejected = await foreign.webContents.executeJavaScript('window.crabotDesktop.startService().then(()=>false,()=>true)')
  assert.equal(rejected, true); assert.equal(starts, 1)
  assert.equal(await trusted.webContents.executeJavaScript('window.crabotDesktop.openUpdateDialog()'), true)
  assert.equal(await foreign.webContents.executeJavaScript('window.crabotDesktop.openUpdateDialog().then(()=>false,()=>true)'), true)
  assert.equal(updateDialogs, 1)
  assert.equal(await trusted.webContents.executeJavaScript('window.crabotDesktop.revealWorkspaceFolder("default")'), true)
  assert.equal(await foreign.webContents.executeJavaScript('window.crabotDesktop.revealWorkspaceFolder("default").then(()=>false,()=>true)'), true)
  assert.equal(await trusted.webContents.executeJavaScript('Promise.resolve().then(()=>window.crabotDesktop.revealWorkspaceFolder("/arbitrary/path")).then(()=>false,()=>true)'), true)
  assert.deepEqual(revealed, ['default'])
  assert.equal(await trusted.webContents.executeJavaScript('window.crabotDesktop.selectWorkspaceDirectory()'), root)
  assert.equal(await foreign.webContents.executeJavaScript('window.crabotDesktop.selectWorkspaceDirectory().then(()=>false,()=>true)'), true)
  assert.equal(directorySelections, 1)
  phase('release-boundaries')
  const { createUpdateDriver } = await module('update-driver.js')
  const candidateResources = path.join(root, 'candidate-resources')
  await fs.mkdir(candidateResources)
  await fs.writeFile(path.join(candidateResources, 'candidate-only.json'), '{}')
  await fs.writeFile(path.join(candidateResources, 'app-update.yml'), 'must not parse or initialize a network updater')
  assert.equal(await createUpdateDriver({ resources: candidateResources, cacheRoot: path.join(root, 'updater-cache'), packaged: true,
    beginExit: () => { throw new Error('Candidate must never prepare an installer') } }), null)
  // A paired-root installation cannot fall back to the legacy NSIS/deb path.
  await fs.unlink(path.join(candidateResources, 'candidate-only.json'))
  await fs.writeFile(path.join(candidateResources, 'desktop-release.json'), '{}')
  assert.equal(await createUpdateDriver({ resources: candidateResources, cacheRoot: path.join(root, 'updater-cache'), packaged: true,
    beginExit: () => { throw new Error('Paired roots must never use a legacy package installer') } }), null)
  // Candidate status must also be inside protected program bytes. A copied
  // update config or a missing outer Resources marker cannot enable a candidate.
  phase('protected-candidate')
  const asar = require('@electron/asar'), candidate = path.join(root, 'protected-candidate'), input = path.join(candidate, 'input')
  await fs.mkdir(input, { recursive: true })
  await fs.writeFile(path.join(input, 'package.json'), '{"type":"module"}')
  await fs.writeFile(path.join(input, 'candidate-only.json'), '{"candidate_only":true}')
  for (const file of ['update-driver.js', 'update-package.js']) await fs.copyFile(path.join(__dirname, '../dist', file), path.join(input, file))
  await fs.symlink(path.resolve(__dirname, '../node_modules'), path.join(candidate, 'node_modules'), 'junction')
  const archive = path.join(candidate, 'app.asar'); await asar.createPackage(input, archive)
  const protectedDriver = await import(pathToFileURL(path.join(archive, 'update-driver.js')).href)
  const emptyResources = path.join(candidate, 'resources'); await fs.mkdir(emptyResources)
  assert.equal(await protectedDriver.createUpdateDriver({ resources: emptyResources, cacheRoot: path.join(candidate, 'cache'), packaged: true,
    beginExit: () => { throw new Error('Protected candidate must never install') } }), null)
  phase('release-transport')
  const { createDesktopReleaseTransport } = await module('release-transport.js')
  await privateSession.cookies.set({ url: origin, name: 'admin-fixture', value: 'must-not-send' })
  const releaseTransport = createDesktopReleaseTransport()
  const publicResponse = await releaseTransport.fetch(externalOrigin + '/release-transport', {
    method: 'POST', credentials: 'include', headers: { Authorization: 'Bearer must-not-send', Cookie: 'private=must-not-send' },
  })
  assert.equal(publicResponse.status, 200)
  await publicResponse.text()
  const releaseRequest = external.find(req => req.url === '/release-transport')
  assert.equal(releaseRequest.authorization, undefined)
  assert.equal(releaseRequest.cookie, undefined); assert.equal(releaseRequest.method, 'GET')
  const landings = external.filter(request => request.url === '/landing').length
  const redirectResponse = await releaseTransport.fetch(origin + '/redirect', {})
  assert.equal(redirectResponse.status, 302)
  await redirectResponse.body?.cancel()
  assert.equal(external.filter(request => request.url === '/landing').length, landings)
  const streamingResponse = await releaseTransport.fetch(origin + '/release-stall', {})
  const reader = streamingResponse.body.getReader(); await reader.read()
  const interrupted = reader.read().then(value => value.done, () => true)
  await releaseTransport.close()
  let streamTimer
  try {
    await Promise.race([releaseStreamClosed, new Promise((_, reject) => {
      streamTimer = setTimeout(() => reject(new Error('Release cancellation did not close the fixture response')), 5000)
    })])
  } finally { clearTimeout(streamTimer) }
  phase('release-stream-close-verified')
  assert.equal(await interrupted, true); reader.releaseLock()
  await assert.rejects(releaseTransport.fetch(externalOrigin + '/closed', {}))
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
  const artifacts = new ArtifactWindows(host)
  const artifactTarget = origin + '/api/media/a232f3cb-a297-440f-8aba-03af28359e36'
  assert.equal(artifacts.open(artifactTarget + '?token=must-not-be-forwarded'), true)
  const artifact = BrowserWindow.getAllWindows().find(window => !windows.includes(window))
  assert.ok(artifact); windows.push(artifact)
  if (artifact.webContents.isLoadingMainFrame()) await once(artifact.webContents, 'did-finish-load')
  const artifactProbe = await artifact.webContents.executeJavaScript('({ ...window.probe, origin:window.origin, storage:(()=>{try{return localStorage.getItem("crabot_admin_token")}catch{return "denied"}})()})')
  assert.deepEqual(artifactProbe, { bridge: 'undefined', node: 'undefined', origin: 'null', storage: 'denied' })
  assert.equal(received.find(req => req.url === '/api/media/a232f3cb-a297-440f-8aba-03af28359e36').authorization, 'Bearer fixture-main-only')
  assert.equal(received.some(req => req.url.includes('must-not-be-forwarded')), false)
  assert.equal(received.some(req => req.url === '/api/artifact-private-probe' && req.authorization), false)
  assert.equal(artifact.webContents.session === privateSession, false)
  const saving = once(artifact.webContents.session, 'will-download')
  artifact.webContents.session.once('will-download', event => event.preventDefault())
  assert.equal(artifacts.open(artifactTarget, true), true)
  const [, item] = await saving
  assert.equal(item.getURL(), artifactTarget)
  assert.equal(received.filter(req => req.url === '/api/media/a232f3cb-a297-440f-8aba-03af28359e36' && req.authorization === 'Bearer fixture-main-only').length, 2)
  artifacts.close()
  // Load the real built React application with only local, explicitly simulated
  // Admin read responses. No model endpoint or business MM is started.
  phase('react-page-loading')
  wholeUi = true
  privateSession.protocol.unhandle('app')
  attachLocalPages(privateSession, path.join(__dirname, '../../crabot-admin/dist/web'))
  await trusted.loadURL('app://crabot/')
  phase('react-page-ready')
  let condition = 0
  async function waitFor(script) {
    const id = ++condition, deadline = Date.now() + 5000
    phase('react-condition-' + id + '-start')
    while (Date.now() < deadline) {
      let timer
      try {
        const evaluation = process.env.CRABOT_BOUNDARY_STALLED_EVALUATION === '1' && id === 1 ? new Promise(() => {}) : trusted.webContents.executeJavaScript(script)
        const ready = await Promise.race([evaluation, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('React condition ' + id + ' renderer execution exceeded its original 5000ms budget')), Math.max(1, deadline - Date.now()))
        })])
        if (ready) { phase('react-condition-' + id + '-ready'); return }
      } finally { clearTimeout(timer) }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('React fixture condition ' + id + ' timed out')
  }
  await waitFor('document.body.textContent.includes("让 Crabot 准备好为你工作") && document.body.textContent.includes("添加模型服务")')
  const evidence = path.join(__dirname, '../../.desktop-build'); await fs.mkdir(evidence, { recursive: true })
  async function captureFixturePage(name) {
    console.log('CRABOT_ELECTRON_CAPTURE ' + name + ' starting')
    await trusted.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))')
    const image = await trusted.webContents.capturePage()
    assert.equal(image.isEmpty(), false, name + ': captured image must contain pixels')
    await fs.writeFile(path.join(evidence, `${name}-${process.platform}-${process.arch}.png`), image.toPNG())
    console.log('CRABOT_ELECTRON_CAPTURE ' + name + ' saved')
  }
  await captureFixturePage('welcome')
  nativeTheme.themeSource = 'light'
  await waitFor('matchMedia("(prefers-color-scheme: light)").matches')
  await trusted.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  await captureFixturePage('welcome-light')
  await trusted.webContents.executeJavaScript('Array.from(document.querySelectorAll("a")).find(link=>link.textContent.includes("稍后设置")).click()')
  await waitFor('!!document.querySelector("textarea") && !document.querySelector("textarea").disabled')
  await trusted.webContents.executeJavaScript('document.querySelector("textarea").focus()')
  await trusted.webContents.insertText('断线后保留的中文草稿')
  await waitFor('document.querySelector("textarea").value === "断线后保留的中文草稿"')
  state = { phase: 'disconnected', app_version: 'fixture', platform: process.platform }
  trusted.webContents.send('desktop:state', state)
  await waitFor('document.body.textContent.includes("与本机服务的连接已断开")')
  state = ready; trusted.webContents.send('desktop:state', state)
  await waitFor('!!document.querySelector("textarea") && !document.querySelector("textarea").disabled')
  await waitFor('document.body.textContent.includes("已同步")')
  await trusted.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  assert.equal(await trusted.webContents.executeJavaScript('document.querySelector("textarea").value'), '断线后保留的中文草稿')
  assert.equal(await trusted.webContents.executeJavaScript('localStorage.getItem("crabot_admin_token")'), null)
  await captureFixturePage('chat')
  await trusted.webContents.executeJavaScript(`document.querySelector('a[href="/desktop/diagnostics"]').click()`)
  await waitFor('document.body.textContent.includes("报告时间")')
  await trusted.webContents.executeJavaScript('Array.from(document.querySelectorAll("button")).find(button=>button.textContent==="导出基础诊断").click()')
  await waitFor('document.body.textContent.includes("本次没有保存文件")')
  assert.equal(exported, preview.report_id)
  const { DesktopController } = await module('controller.js')
  const failure = new DesktopController({ coreRoot: path.join(__dirname, '../..'), dataRoot: root, appVersion: 'fixture', platform: process.platform })
  failure.fail(Object.assign(new Error('synthetic product integrity failure'), { code: 'CRABOT_RUNTIME_INVALID' }))
  state = failure.host.snapshot(); failure.close()
  trusted.webContents.send('desktop:state', state)
  await waitFor('!!Array.from(document.querySelectorAll("button")).find(button=>button.textContent==="本地诊断")')
  await trusted.webContents.executeJavaScript('Array.from(document.querySelectorAll("button")).find(button=>button.textContent==="本地诊断").click()')
  await waitFor('!!document.querySelector(".desktop-status .desktop-diagnostics dd")')
  assert.equal(preview.state.phase, 'error')
  await trusted.webContents.executeJavaScript('Array.from(document.querySelector(".desktop-status .desktop-diagnostics").querySelectorAll("button")).find(button=>button.textContent==="安装与修复说明").click()')
  assert.equal(await helpRequest, 'https://github.com/smilefufu/crabot-docs/blob/main/guides/desktop-usage.md')
  await waitFor('document.body.textContent.includes("内置运行文件未通过校验") && !!Array.from(document.querySelector(".desktop-status .desktop-diagnostics").querySelectorAll("button")).find(button=>button.textContent==="重新检查" && !button.disabled)')
  await trusted.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  await captureFixturePage('diagnostics')
  console.log('CRABOT_ELECTRON_BOUNDARY ' + JSON.stringify({ electron: process.versions.electron, node: process.versions.node,
    sandbox: true, isolated_preload: true, current_frame_ipc: true, direct_http_header: true, direct_ws_header: true,
    foreign_frame_denied: true, redirect_token_absent: true, isolated_artifact_preview: true, built_react_app: true, reconnect_keeps_draft: true, independent_diagnostics: true, repair_help_ipc: true, paired_legacy_installer_blocked: true, anonymous_release_transport: true, manual_release_redirect: true, release_stream_cancelled: true }))
}
main().then(() => cleanup(0), error => { console.error('Electron boundary fixture failed:', error); void cleanup(1) })
async function cleanup(code) {
  clients.forEach(client => client.terminate())
  windows.forEach(window => { if (!window.isDestroyed()) window.destroy() })
  const closed = servers.map(server => new Promise(resolve => server.close(resolve)))
  connections.forEach(socket => socket.destroy()) // Only sockets accepted by these private fixture servers.
  await Promise.all(closed)
  phase('cleanup-complete-' + code)
  app.exit(code)
}
