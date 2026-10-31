import { readRemovalHostRequest } from './removal-request.js'
import { startDesktopRemovalHost } from './removal-host.js'
import { revealWorkspaceFolder, selectWorkspaceDirectory } from './workspace-folder.js'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, session, shell, Tray } from 'electron'
import path from 'node:path'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { access, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { DesktopDiagnostics } from 'crabot-client'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DesktopController } from './controller.js'
import { attachLocalPages } from './local-pages.js'
import { attachDesktopNetwork } from './desktop-network.js'
import { registerDesktopIpc } from './desktop-ipc.js'
import { collectDiagnostics } from './diagnostics.js'
import { openBootstrapLog, logBootstrapException } from './bootstrap-log.js'
import { ArtifactWindows } from './artifact-window.js'
import { LoginStartup, type StartupState } from './login-startup.js'
import { externalUrl, isAppUrl, isTrustedFrame, allowsDesktopClipboardWrite } from './window-security.js'
import { UpdateDialog } from './update-dialog.js'
import { createUpdateDriver } from './update-driver.js'
import { createPairedUpdateHost } from './paired-update-host.js'
import { createDesktopReleaseTransport } from './release-transport.js'
import { desktopReleasePublicKeys } from './release-trust.js'
import { verifyUpdateDownload } from './update-package.js'

app.setName(app.isPackaged ? 'Crabot' : 'Crabot Dev')
if (process.platform === 'linux') app.setDesktopName('crabot.desktop')
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const directory = path.dirname(fileURLToPath(import.meta.url))
let coreRoot = app.isPackaged ? path.join(process.resourcesPath, 'core') : path.resolve(app.getAppPath(), '..')
const loadCore = (file: string) => import(pathToFileURL(path.join(coreRoot, file)).href)
let window: BrowserWindow | undefined, tray: Tray | undefined, controller: DesktopController | undefined
let dataRoot = path.join(homedir(), '.crabot/data'), initialError: unknown, quitting = false
let pendingQuit: Promise<boolean> | undefined
let artifacts: ArtifactWindows | undefined
let updates: UpdateDialog | undefined
let updateRequested = process.argv.includes('--check-updates')
let installingCli = false
let verifyBinding: (() => void) | undefined
let cancelRemovalHost: (() => void) | undefined
let uninstallRequested = process.platform === 'win32' && process.argv.includes('--uninstall')
let requestUninstall: (() => Promise<void>) | undefined
let pendingUninstall: Promise<void> | undefined
let instanceHandlerRegistered = false

function uninstallInstallation(installRoot: string): Promise<void> {
  return pendingUninstall ||= (async () => {
    try {
      const { startGuiRemovalFromSource } = await import('./removal-source.js')
      await startGuiRemovalFromSource({ installRoot, operationId: randomUUID(), beginExit: () => {
        quitting = true; return () => { quitting = false }
      } })
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      bootstrapStage('uninstall-unconfirmed', { code: typeof code === 'string' && /^[A-Z0-9_]{1,128}$/.test(code) ? code : 'CRABOT_DESKTOP_REMOVAL' })
      await dialog.showMessageBox({ type: 'error', title: '卸载尚未完成', message: 'Crabot 尚未卸载完成，用户数据已保留。',
        detail: '请核对当前维护进度后重试；如果原程序已不完整，请用同版或更高版离线安装器继续。', buttons: ['知道了'] })
    }
  })().finally(() => { pendingUninstall = undefined })
}

async function bootUninstall() {
  if (!app.isPackaged) throw new Error('Installed application required')
  const verifier = createRequire(import.meta.url)('./bootstrap/scripts/lib/desktop-installation.cjs')
  const pin = readFileSync(path.join(directory, 'desktop-release.json'), 'utf8')
  const own = verifier.locateDesktopRemovalGui(process.resourcesPath, pin)
  // Reject a corrupt fence before even creating the source GUI's UI profile.
  createRequire(import.meta.url)('./bootstrap/scripts/lib/desktop-removal-record.cjs').readDesktopRemoval(own.root)
  dataRoot = own.dataDir; configureProfile(dataRoot)
  if (!claimInstance()) return
  await app.whenReady()
  requestUninstall = () => uninstallInstallation(own.root)
  await requestUninstall()
  quitting = true; app.quit()
}

async function quit(): Promise<boolean> {
  if (pendingUninstall) return false
  if (pendingQuit) return pendingQuit
  pendingQuit = (async () => {
    const state = controller?.host.snapshot()
    if (state && state.phase !== 'stopped' && state.phase !== 'migration_required') {
      const answer = await dialog.showMessageBox({ type: 'question', title: '退出 Crabot', message: '退出将停止共享的 Crabot 服务。',
        detail: '正在进行的任务和其他客户端连接会受影响。关闭窗口可以继续后台运行。', buttons: ['取消', '停止服务并退出'], defaultId: 0, cancelId: 0 })
      if (answer.response !== 1) return false
      if ((await controller!.stop()).phase !== 'stopped') {
        await dialog.showMessageBox({ type: 'error', message: '未能确认服务已停止。', detail: '已保留运行记录，请检查诊断后重试。' })
        return false
      }
    }
    quitting = true; app.quit(); return true
  })().finally(() => { pendingQuit = undefined })
  return pendingQuit
}
function show() { window?.show(); window?.focus() }
const bootstrapHistory: { phase: string; at: string; code?: string; app_version?: string }[] = []
let bootstrapLog: ReturnType<typeof openBootstrapLog>
process.on('uncaughtExceptionMonitor', error => logBootstrapException(event => bootstrapLog?.(event), error))
function bootstrapStage(phase: string, fields: { code?: string; app_version?: string } = {}) {
  const event = { phase, at: new Date().toISOString(), ...fields }
  const line = JSON.stringify({ component: 'desktop-bootstrap', ...event })
  if (phase === 'failed') console.error(line); else console.info(line)
  if (bootstrapHistory.length < 32) bootstrapHistory.push(event)
  bootstrapLog?.(event)
}

function configureProfile(root: string) {
  const profile = path.join(root, 'desktop-profile'), temporary = path.join(profile, 'tmp')
  mkdirSync(temporary, { recursive: true, mode: 0o700 })
  try {
    const files = createRequire(import.meta.url)(app.isPackaged ? './bootstrap/scripts/lib/process-identity.cjs' : path.join(coreRoot, 'scripts/lib/process-identity.cjs'))
    bootstrapLog = openBootstrapLog(profile, files)
    for (const event of bootstrapHistory) bootstrapLog?.(event)
  } catch { /* Console metadata remains available if the private log is unavailable. */ }
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
  app.setPath('temp', temporary)
}
function claimInstance() {
  if (!app.requestSingleInstanceLock()) { bootstrapStage('instance-lock-denied'); quitting = true; app.quit(); return false }
  bootstrapStage('instance-lock-acquired')
  if (instanceHandlerRegistered) return true
  instanceHandlerRegistered = true
  app.on('second-instance', (_event, args) => {
    if (process.platform === 'win32' && args.includes('--uninstall')) {
      uninstallRequested = true; if (requestUninstall) void requestUninstall(); return
    }
    show()
    if (args.includes('--check-updates')) { updateRequested = true; if (updates) void updates.open() }
  })
  return true
}

async function boot() {
  const removal = readRemovalHostRequest(process.argv)
  if (removal) {
    const host = startDesktopRemovalHost(removal)
    cancelRemovalHost = host.cancel
    await host.finished
    cancelRemovalHost = undefined; quitting = true; app.quit(); return
  }
  if (uninstallRequested) { await bootUninstall(); return }
  const installationProbe = process.argv.filter(value => value.startsWith('--installation-sandbox-probe='))
  if (installationProbe.length) {
    if (installationProbe.length !== 1) { app.exit(1); return }
    const { runInstallationSandboxProbe } = await import('./installation-sandbox-probe.js')
    await runInstallationSandboxProbe(installationProbe[0].slice('--installation-sandbox-probe='.length))
    return
  }
  bootstrapStage('binding-installation')
  // Resolve the protected GUI identity before external code or privileged UI.
  // A failed pair binding must not fall back to Resources/core.
  bootstrapStage('loading-installation-verifier')
  const verifier = app.isPackaged ? createRequire(import.meta.url)('./bootstrap/scripts/lib/desktop-installation.cjs') : null
  bootstrapStage('installation-verifier-loaded')
  let pin: string | undefined
  if (verifier) {
    try { pin = readFileSync(path.join(directory, 'desktop-release.json'), 'utf8') }
    catch (error: any) { if (error.code !== 'ENOENT') throw error }
  }
  bootstrapStage('installation-pin-read')
  let windowsInstallation
  const windowsRoot = path.resolve(process.resourcesPath, '../../../..')
  const windowsFirstUse = app.isPackaged && process.platform === 'win32' && pin !== undefined
    && (!existsSync(path.join(windowsRoot, 'current-release.json')) || readFileSync(path.join(windowsRoot, 'current-release.json'), 'utf8') !== pin)
  if (windowsFirstUse) {
    configureProfile(path.join(app.getPath('appData'), 'Crabot/bootstrap'))
    if (!claimInstance()) return
    await app.whenReady()
    const { prepareWindowsFirstLaunch } = await import('./windows-first-launch.js')
    const { registerInstallationEntries } = await import('./installation-entries.js')
    windowsInstallation = await prepareWindowsFirstLaunch({ resources: process.resourcesPath, pinText: pin!, home: homedir(), dialog,
      load: (name, verifiedCore) => import(verifiedCore ? pathToFileURL(path.join(verifiedCore, 'scripts/lib', name)).href : new URL('./bootstrap/scripts/lib/' + name, import.meta.url).href),
      registerEntries: prepared => registerInstallationEntries(prepared, { home: homedir(), platform: process.platform, env: process.env, shell }),
      upgradeExisting: async (prepared, source) => {
        const { applyWindowsOfflineUpdate } = await import('./windows-offline-update.js')
        return applyWindowsOfflineUpdate({ prepared, source, app, dialog, shell, home: homedir() })
      } })
    if (!windowsInstallation) { quitting = true; app.quit(); return }
    app.releaseSingleInstanceLock()
  }
  const discovered = verifier?.locateDesktopGui(process.resourcesPath)
  bootstrapStage('installation-discovered')
  const installation = pin !== undefined || discovered ? verifier.locatePinnedDesktopGui(process.resourcesPath, pin) : undefined
  bootstrapStage('installation-validated')
  if (installation) {
    // Electron needs its UI profile and instance lock before the first await.
    // Only protected GUI code touches this profile; Core still requires a full hash.
    verifier.applyDesktopEnvironment(installation)
    bootstrapStage('environment-bound')
    const management = createRequire(import.meta.url)('./bootstrap/scripts/lib/desktop-management.cjs')
    dataRoot = management.requireExistingDataRoot(installation.dataDir)
    configureProfile(dataRoot)
    bootstrapStage('profile-configured')
    if (!claimInstance()) return
    const { verifyCoreRelease } = await import(pathToFileURL(path.join(directory, 'bootstrap/scripts/lib/core-release.mjs')).href)
    const release = await verifyCoreRelease(installation.coreRoot, { version: installation.selection.version })
    if (release.inventory_sha256 !== installation.selection.core_id) throw Object.assign(new Error('Protected Core identity changed'), { code: 'CRABOT_CORE_INTEGRITY' })
    verifyBinding = () => { verifier.locatePinnedDesktopGui(process.resourcesPath, pin) }
    coreRoot = installation.coreRoot
  }
  bootstrapStage('installation-bound')
  const macApp = app.isPackaged && process.platform === 'darwin' && !installation
  if (macApp) {
    // All self-contained Mac launches share this small profile while claiming
    // the GUI lock, even before the first data location has been selected.
    configureProfile(path.join(app.getPath('appData'), 'Crabot/bootstrap'))
    if (!claimInstance()) return
    await app.whenReady()
    const { prepareMacAppData } = await import('./mac-first-launch.js')
    const selected = await prepareMacAppData({ appPath: path.resolve(path.dirname(process.execPath), '../..'), coreRoot,
      home: homedir(), dialog, version: app.getVersion(),
      load: name => import(new URL('./bootstrap/scripts/lib/' + name, import.meta.url).href),
      discoverLegacy: async root => {
        const { discoverUserSourceDeployment } = await loadCore('scripts/lib/source-installation.mjs')
        if (root === path.join(homedir(), '.crabot') && discoverUserSourceDeployment()) return null
        const { discoverLegacyDesktopTakeover } = await loadCore('scripts/lib/legacy-desktop-discovery.mjs')
        const legacy = await discoverLegacyDesktopTakeover({ root, source: {} })
        if (!legacy && existsSync(path.join(root, 'data')) && !existsSync(path.join(root, 'desktop-installation.json'))) {
          throw Object.assign(new Error('此处有数据，但尚未核实对应的受支持旧发行程序。'), { code: 'CRABOT_LEGACY_UNSUPPORTED' })
        }
        return legacy
      },
      adoptLegacy: async (root, dataDir) => {
        const { runMacLegacyHandoff } = await import('./mac-legacy-handoff.js')
        await runMacLegacyHandoff(coreRoot, root, dataDir, app.getVersion())
      } })
    if (!selected) { quitting = true; app.quit(); return }
    dataRoot = selected
    const binding = (await loadCore('scripts/lib/mac-app-binding.cjs')).default
    binding.applyMacAppEnvironment(coreRoot)
    verifyBinding = () => { binding.applyMacAppEnvironment(coreRoot) }
    configureProfile(dataRoot)
  }
  try {
    const { resolveCliDataDir } = await loadCore('scripts/lib/instance.mjs')
    const resolved = path.resolve(resolveCliDataDir({ homeDir: path.join(homedir(), '.crabot') }))
    if (installation && resolved !== dataRoot) throw Object.assign(new Error('Installed data binding changed'), { code: 'CRABOT_DESKTOP_INSTALLATION' })
    dataRoot = resolved
    const management = (await loadCore('scripts/lib/desktop-management.cjs')).default
    dataRoot = installation || existsSync(dataRoot) ? management.requireExistingDataRoot(dataRoot) : management.ensurePrivateDataRoot(dataRoot)
    if (!installation) configureProfile(dataRoot)
  } catch (error) { initialError = error }
  bootstrapStage('data-location-checked')
  if (!installation && !macApp && !claimInstance()) return
  await app.whenReady()
  if (process.platform === 'win32') app.setAppUserModelId('com.crabot.desktop')
  bootstrapStage('app-ready', { app_version: app.getVersion() })
  const startup = new LoginStartup({ platform: process.platform, packaged: app.isPackaged, executable: process.execPath,
    configHome: path.resolve(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config')), app })
  bootstrapStage('reading-login-startup')
  let startupState: StartupState = await startup.get().catch(() => ({ supported: app.isPackaged, enabled: false, approvalRequired: false }))
  bootstrapStage('login-startup-read')
  const background = process.argv.includes('--background') || startup.launchedAtLogin()
  await access(path.join(coreRoot, 'crabot-admin/dist/web/desktop.html'))
  controller = new DesktopController({ coreRoot, dataRoot, appVersion: app.getVersion(), platform: process.platform as 'darwin' | 'win32' | 'linux', packaged: app.isPackaged, verifyBinding, loginStartup: startup,
    loginStartupRecovered: state => {
      if (state) { startupState = state; updateMenus() }
      else void dialog.showMessageBox({ type: 'warning', message: '登录启动设置尚未恢复。',
        detail: '服务仍按正常流程恢复。请在系统登录项中核对 Crabot，也可从应用菜单重新设置。更新记录和业务数据已保留。', buttons: ['知道了'] }).catch(() => {})
    } })
  let driver = null, configurationError = false
  const beginUpdateExit = () => { quitting = true; return () => { quitting = false } }
  try { driver = await createUpdateDriver({ resources: process.resourcesPath, cacheRoot: path.join(dataRoot, 'runtime-cache'), packaged: app.isPackaged,
    beginExit: beginUpdateExit, paired: () => createPairedUpdateHost({ coreRoot, dataRoot, appVersion: app.getVersion(), verifyBinding,
      pinnedPublicKeys: desktopReleasePublicKeys, controller: controller!, transport: createDesktopReleaseTransport, app, beginExit: beginUpdateExit,
      entries: { home: homedir(), platform: process.platform, env: process.env, shell } }) }) }
  catch { configurationError = true }
  updates = new UpdateDialog({ version: app.getVersion(), driver, configurationError, show: options => dialog.showMessageBox(options),
    activity: () => controller!.updateActivity(), prepareInstall: async (update, install) => {
      if ('kind' in update) await install()
      else {
        await verifyUpdateDownload(update)
        await controller!.prepareUpdate(update, install)
      }
    } })
  artifacts = new ArtifactWindows(controller.host, () => { if (!quitting) updateMenus() })
  const privateSession = session.fromPartition('persist:crabot-desktop')
  privateSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(allowsDesktopClipboardWrite(contents, window?.webContents, permission, details)))
  privateSession.setPermissionCheckHandler((contents, permission, origin, details) =>
    isAppUrl(origin) && allowsDesktopClipboardWrite(contents, window?.webContents, permission, details))
  attachLocalPages(privateSession, path.join(coreRoot, 'crabot-admin/dist/web'))
  attachDesktopNetwork(privateSession, controller.host, () => window?.webContents)
  window = new BrowserWindow({ width: 1180, height: 800, minWidth: 800, minHeight: 560, show: false, title: 'Crabot',
    backgroundColor: '#f5f5f7', autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: { session: privateSession, preload: path.join(directory, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false } })
  const reports = new Map<string, DesktopDiagnostics>()
  const diagnostics = async () => {
    const report = await collectDiagnostics(coreRoot, controller!.host.snapshot(), controller!.host.recent())
    reports.set(report.report_id, report)
    while (reports.size > 4) reports.delete(reports.keys().next().value!)
    return report
  }
  registerDesktopIpc({ ipc: ipcMain, contents: () => window?.webContents, controller, quit, diagnostics,
    openUpdateDialog: () => updates!.open(),
    openExternal: url => shell.openExternal(url), revealData: async () => !(await shell.openPath(dataRoot)),
    revealWorkspace: id => revealWorkspaceFolder(controller!.host, id, value => shell.openPath(value)),
    selectWorkspace: () => selectWorkspaceDirectory(controller!.host, async () => {
      const owner = window
      if (!owner || owner.isDestroyed()) return null
      const selected = await dialog.showOpenDialog(owner, { title: '选择工作目录迁移位置', buttonLabel: '选择这个文件夹', properties: ['openDirectory'] })
      if (selected.canceled || selected.filePaths.length !== 1) return null
      return selected.filePaths[0]
    }),
    exportDiagnostics: async id => {
      const report = reports.get(id)
      if (!report) return false
      const chosen = await dialog.showSaveDialog({ title: '导出基础诊断', defaultPath: 'crabot-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (chosen.canceled || !chosen.filePath) return false
      const temporary = chosen.filePath + '.tmp-' + randomUUID()
      let created = false
      try {
        await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); created = true
        await rename(temporary, chosen.filePath); return true
      } catch { return false }
      finally { if (created) await rm(temporary, { force: true }).catch(() => {}) }
    },
  })
  controller.host.subscribe(state => {
    console.info(JSON.stringify({ component: 'desktop', phase: state.phase, at: new Date().toISOString(), ...('code' in state && state.code ? { code: state.code } : {}) }))
    if (!window?.isDestroyed() && window?.webContents.mainFrame && isTrustedFrame(window.webContents.mainFrame, window.webContents)) window.webContents.send('desktop:state', state)
    tray?.setToolTip(`Crabot · ${state.phase === 'ready' ? '运行中' : state.phase === 'stopped' ? '已停止' : '正在检查'}`)
    if (tray) updateMenus()
  })
  const openLink = (url: string) => { if (artifacts!.open(url)) return; const allowed = externalUrl(url); if (allowed) void shell.openExternal(allowed) }
  window.webContents.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' } })
  window.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url) || url.startsWith('app://crabot/api/media/')) { event.preventDefault(); openLink(url) } })
  privateSession.on('will-download', (event, item, contents) => {
    event.preventDefault()
    if (contents === window?.webContents && item.getInitiatorOrigin() === 'app://crabot') artifacts!.open(item.getURL(), true)
  })
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide() } })
  window.once('ready-to-show', () => { if (!background) show() })
  const trayImage = nativeImage.createFromBuffer(await readFile(path.join(directory, 'assets/tray.png')))
  if (trayImage.isEmpty()) throw new Error('Desktop tray asset is invalid')
  tray = new Tray(trayImage.resize({ width: 20, height: 20 }))
  tray.setToolTip('Crabot')
  async function changeStartup(enabled: boolean) {
    try {
      startupState = await startup.set(enabled)
      if (startupState.approvalRequired) {
        const answer = await dialog.showMessageBox({ type: 'info', message: '登录启动还需要系统允许。', detail: '请在系统设置的“通用 → 登录项”中允许 Crabot。', buttons: ['知道了', '打开系统设置'] })
        if (answer.response === 1) await shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension')
      }
    } catch (error) { await dialog.showMessageBox({ type: 'error', message: '登录启动设置未完成。', detail: error instanceof Error ? error.message : '请检查系统登录项后重试。' }) }
    finally { updateMenus() }
  }
  async function installCli() {
    if (installingCli || quitting) return
    installingCli = true
    updateMenus()
    try {
      const answer = await dialog.showMessageBox({ type: 'question', title: '安装管理命令', message: '为当前用户安装 crabot 命令？',
        detail: '将添加用户级命令入口并配置 PATH。之后可在新终端中用 crabot status 等命令管理本机共享实例。',
        buttons: ['取消', '安装命令'], defaultId: 0, cancelId: 0 })
      if (answer.response !== 1) return
      const { installDesktopCli } = await loadCore('scripts/lib/desktop-cli-install.mjs')
      const result = await installDesktopCli({ coreRoot, dataDir: dataRoot })
      await dialog.showMessageBox({ type: 'info', title: '管理命令', message: 'crabot 命令入口已安装。',
        detail: result.notification_sent ? '请打开一个新终端使用。' : '系统环境通知尚未完成。新终端若仍未识别命令，请注销并重新登录后使用。', buttons: ['知道了'] })
    } catch (error) {
      const value = error as { code?: string; message?: string }
      await dialog.showMessageBox({ type: 'error', title: '管理命令尚未安装完成',
        message: value.code === 'CRABOT_CLI_INSTALL_REQUIRED' && value.message ? value.message : '命令注册未完成，请检查安装和用户目录的访问权限后重试。',
        detail: '可以再次从此菜单继续安装。服务和业务数据保留。', buttons: ['知道了'] })
    } finally { installingCli = false; if (!quitting) updateMenus() }
  }
  function updateMenus() {
    const cliItem = () => ({ label: installingCli ? '正在安装 crabot 命令…' : '安装 crabot 命令…',
      enabled: app.isPackaged && !installingCli && controller?.host.snapshot().phase !== 'migration_required', click: () => { void installCli() } })
    const uninstallItems = () => process.platform === 'darwin' && !installation ? [] : [{ label: pendingUninstall ? '正在卸载 Crabot…' : '卸载 Crabot…',
      enabled: !!requestUninstall && !pendingUninstall && !quitting, click: () => { void requestUninstall?.() } }]
    const startupItem = () => ({ label: '登录后在后台启动' + (startupState.approvalRequired ? '（待系统允许）' : ''), type: 'checkbox' as const,
      checked: startupState.enabled || startupState.approvalRequired, enabled: startupState.supported && controller?.host.snapshot().phase !== 'migration_required',
      click: (item: Electron.MenuItem) => { void changeStartup(item.checked) } })
    tray?.setContextMenu(Menu.buildFromTemplate([{ label: '打开 Crabot', click: show }, { type: 'separator' },
      { label: '启动服务', click: () => { void controller!.start() } }, { label: '停止服务', click: () => { void controller!.stop() } },
      { type: 'separator' }, startupItem(), cliItem(), ...uninstallItems(), { label: '检查更新…', click: () => { void updates!.open() } }, { label: '退出 Crabot', click: () => { void quit() } }]))
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Crabot', submenu: [{ label: '打开 Crabot', click: show }, startupItem(),
        cliItem(), ...uninstallItems(),
        { label: '检查更新…', click: () => { void updates!.open() } }, { type: 'separator' }, { label: '退出 Crabot', accelerator: 'CommandOrControl+Q', click: () => { void quit() } }] },
      { label: '文件', submenu: [{ label: '保存当前附件…', accelerator: 'CommandOrControl+S', enabled: artifacts?.hasFocused(), click: () => { artifacts?.saveFocused() } }] },
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]))
  }
  updateMenus()
  window.on('focus', updateMenus)
  tray.on('click', show)
  bootstrapStage('loading-local-interface')
  await window.loadURL('app://crabot/')
  bootstrapStage('local-interface-loaded')
  if (installation) { requestUninstall = () => uninstallInstallation(installation.root); updateMenus() }
  if (uninstallRequested && requestUninstall) { await requestUninstall(); controller.watch(); return }
  // The local UI is visible while the controller verifies the large payload.
  if (initialError) controller.fail(initialError)
  else {
    bootstrapStage('recovering-service')
    void controller.recoverVersion().then(recovered => { if (!recovered) void controller!.start() }).catch(error => controller!.fail(error))
    controller.watch()
  }
  updates.start()
  if (updateRequested) void updates.open()
}
app.on('activate', show)
app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault()
  if (pendingUninstall) return
  if (cancelRemovalHost) cancelRemovalHost()
  else void quit()
})
app.on('window-all-closed', () => { /* Tray owns the application lifetime. */ })
app.on('will-quit', () => { updates?.close(); artifacts?.close(); controller?.close(); tray?.destroy() })
void boot().catch(async error => {
  if (error?.code === 'CRABOT_DESKTOP_REMOVAL_PENDING' && app.isPackaged) {
    try { await bootUninstall(); return } catch (failure) { error = failure }
  }
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,128}$/.test(error.code) ? error.code : 'DESKTOP_BOOT_FAILED'
  bootstrapStage('failed', { code })
  await app.whenReady()
  let message = 'Crabot 界面启动失败，请修复安装。'
  if (['CRABOT_MAC_APP_BINDING', 'CRABOT_MAC_ADMISSION', 'CRABOT_DATA_MISSING', 'CRABOT_DESKTOP_TAKEOVER_REQUIRED'].includes(error?.code)) message = error.message
  if (['CRABOT_DESKTOP_REMOVAL', 'CRABOT_DESKTOP_REMOVAL_PENDING'].includes(error?.code)) message = 'Crabot 卸载尚未完成。请继续卸载，或使用同版/更高版离线安装器修复。用户数据已保留。'
  else if (['CRABOT_DESKTOP_INSTALLATION', 'CRABOT_CORE_INTEGRITY'].includes(error?.code)) message = 'Crabot 安装位置、内置文件或版本对未通过校验，请使用同版或更高版安装包修复。已有数据保留。'
  await dialog.showMessageBox({ type: 'error', message })
  quitting = true; app.quit()
})
