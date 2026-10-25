// The offline installer has its own application entry and never starts MM.
import { app, dialog, shell } from 'electron'
import path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { z } from 'crabot-client'
import { registerInstallationEntries, readInstallationLocator, type PreparedInstallation } from './installation-entries.js'
import { createInstallationProgressWindow } from './installation-progress-window.js'
const directory = path.dirname(fileURLToPath(import.meta.url))
app.setName('安装 Crabot')
const preparedSchema = z.object({ installRoot: z.string().min(1), installation_id: z.uuid(), coreRoot: z.string().min(1), guiRoot: z.string().min(1),
  selection: z.object({ schema_version: z.literal(1), version: z.string().min(1), gui_id: z.uuid(), core_id: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict()
let exitCode = 2
const labels: Record<string, string> = { verifying: '正在核验离线安装组件…', copying: '正在安装 Crabot 和内置运行环境…', prepared: '正在核验安装结果…' }
function failure(error: unknown) {
  const code = (error as { code?: string })?.code
  if (code === 'CRABOT_UPDATE_SPACE' || code === 'ENOSPC') return '磁盘空间不足。已保留原目录，请释放空间后重试，或选择其他安装位置。'
  if (code === 'CRABOT_INSTALL_FILESYSTEM') return '请选择支持私有文件权限的本机持久卷。网络、临时或不支持的磁盘不能用于此安装。'
  if (code === 'CRABOT_CORE_INTEGRITY') return '离线安装包不完整或已改变。请重新获取完整安装包后重试。'
  if (code === 'CRABOT_INSTALL_SYSTEM_MODE') return '此机器由管理员统一部署，请通过浏览器或渠道使用 Crabot。桌面安装未更改任何实例。'
  if (code === 'CRABOT_DESKTOP_TAKEOVER_REQUIRED') return '检测到已有 Crabot 部署，需要沿用原安装位置进行接管。原数据已保留，未创建新实例。'
  if (code === 'CRABOT_DESKTOP_INSTALLATION' && error instanceof Error && error.message.length <= 512) return error.message
  if (code === 'CRABOT_INSTALL_REGISTRATION') return '系统应用入口与已有文件冲突。原文件已保留，请核对原安装后重试。'
  return '安装尚未完成，现有文件和准备记录已保留。请核对所选位置及访问权限，再使用同一安装包继续。'
}
async function boot() {
  const profile = await mkdtemp(path.join(tmpdir(), 'crabot-installer-'))
  app.setPath('userData', profile); app.setPath('sessionData', profile)
  await app.whenReady()
  if (process.platform === 'win32') app.setAppUserModelId('com.crabot.installer')
  const backend = await import(pathToFileURL(path.join(directory, 'bootstrap/scripts/lib/desktop-payload.mjs')).href)
  const { detectMode } = await import(pathToFileURL(path.join(directory, 'bootstrap/scripts/lib/mode.mjs')).href)
  if (detectMode() === 'system') throw Object.assign(new Error('System deployment'), { code: 'CRABOT_INSTALL_SYSTEM_MODE' })
  const payload = path.join(process.resourcesPath, 'offline')
  const locator = await readInstallationLocator(homedir(), process.platform, process.env)
  const requested = process.argv.filter(value => value.startsWith('--install-root='))
  if (requested.length > 1) throw new Error('Invalid installer destination')
  let preselected = requested.length === 1
  let selected = requested[0]?.slice('--install-root='.length) || locator?.install_root || path.join(homedir(), 'Crabot')
  if (!path.isAbsolute(selected) || /[\r\n\0]/.test(selected)) throw new Error('Invalid installer destination')
  selected = path.resolve(selected)
  // Existing user data must be handled by the takeover flow, never bypassed by
  // choosing another empty root. Its integration remains part of I3.
  if (!locator) {
    const { assertFreshUserInstallation } = await import(pathToFileURL(path.join(directory, 'bootstrap/scripts/lib/legacy-desktop.mjs')).href)
    await assertFreshUserInstallation({ home: homedir(), source: process.env })
  }
  const welcome = preselected ? { response: 0 } : await dialog.showMessageBox({ type: 'info', title: '安装 Crabot', message: '欢迎安装 Crabot',
    detail: '已包含运行环境，无需额外安装。主要程序和数据将保存在你选择的安装文件夹；工作区可在安装后调整。', buttons: ['继续', '退出'], defaultId: 0, cancelId: 1 })
  if (welcome.response !== 0) return
  while (true) {
    const chosen = preselected ? { canceled: false, filePaths: [selected] } : await dialog.showOpenDialog({ title: '选择 Crabot 安装文件夹', defaultPath: selected, buttonLabel: '安装到这里', properties: ['openDirectory', 'createDirectory', 'promptToCreate'] })
    preselected = false
    if (chosen.canceled || chosen.filePaths.length !== 1) return
    selected = chosen.filePaths[0]
    const confirmation = await dialog.showMessageBox({ type: 'question', title: '安装位置', message: '将 Crabot 安装到所选文件夹？', detail: selected,
      buttons: ['安装', '重新选择', '取消'], defaultId: 0, cancelId: 2 })
    if (confirmation.response === 2) return
    if (confirmation.response !== 0) continue
    const abort = new AbortController(), progress = createInstallationProgressWindow(abort)
    let installed: { executable: string; dataDir: string } | undefined
    try {
      await progress.ready
      const prepared: PreparedInstallation = preparedSchema.parse(await backend.prepareDesktopInstallation({ payload, installRoot: selected, signal: abort.signal,
        progress: (phase: string) => progress.update(labels[phase] || '正在核验安装结果…') }))
      progress.update('正在注册系统应用入口…', false)
      await registerInstallationEntries(prepared, { home: homedir(), platform: process.platform, env: process.env, shell })
      installed = await backend.commitDesktopInstallation(prepared)
      exitCode = 0
    } catch (error) {
      exitCode = abort.signal.aborted ? 2 : 1
      progress.close()
      const answer = await dialog.showMessageBox({ type: abort.signal.aborted ? 'info' : 'error', title: '安装尚未完成',
        message: abort.signal.aborted ? '安装已取消，准备记录已保留。' : failure(error), detail: '可以使用同一安装包和安装位置继续。',
        buttons: ['重试', '退出'], defaultId: 0, cancelId: 1 })
      if (answer.response === 0) continue
      return
    } finally { progress.close() }
    const complete = await dialog.showMessageBox({ type: 'info', title: '安装完成', message: 'Crabot 已安装', detail: '现在可以打开应用，完成模型配置并开始使用。', buttons: ['打开 Crabot', '完成'], defaultId: 0, cancelId: 1 })
    if (complete.response === 0 && installed) {
      const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: installed.dataDir }
      for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET', 'CRABOT_HOME']) delete env[name]
      try {
        const child = spawn(installed.executable, [], { env, detached: true, stdio: 'ignore' })
        await once(child, 'spawn'); child.unref()
      } catch { await dialog.showMessageBox({ type: 'error', title: '应用尚未启动', message: 'Crabot 已安装，可从系统应用入口重新打开。' }) }
    }
    return
  }
}
app.on('window-all-closed', () => { /* Native dialogs own the installer lifetime. */ })
void boot().catch(async error => { exitCode = 1; if (!app.isReady()) await app.whenReady(); await dialog.showMessageBox({ type: 'error', title: '安装尚未完成', message: failure(error) }) }).finally(() => app.exit(exitCode))
