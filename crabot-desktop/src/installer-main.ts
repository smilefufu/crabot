// The offline installer has its own application entry and never starts MM.
import { app, dialog, shell } from 'electron'
import path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { z } from 'crabot-client'
import { registerInstallationEntries, registerRetainedInstallationEntries, readInstallationLocator, type PreparedInstallation } from './installation-entries.js'
import { createInstallationProgressWindow } from './installation-progress-window.js'
import { prepareRetainedDesktopReinstall, inspectRetainedDesktopRemoval } from './retained-reinstall.js'
import { discoverLegacyTakeover, installLegacyTakeover, type LegacyTakeoverSource } from './legacy-takeover.js'
const directory = path.dirname(fileURLToPath(import.meta.url))
app.setName('安装 Crabot')
const preparedSchema = z.object({ installRoot: z.string().min(1), installation_id: z.uuid(), coreRoot: z.string().min(1), guiRoot: z.string().min(1),
  selection: z.object({ schema_version: z.literal(1), version: z.string().min(1), gui_id: z.uuid(), core_id: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict()
let exitCode = 2
const labels: Record<string, string> = { verifying: '正在核验离线安装组件…', copying: '正在安装 Crabot 和内置运行环境…', prepared: '正在核验安装结果…', restoring: '正在修复程序，保留原数据…', 'handing-off': '正在注册入口并准备恢复服务…', previewing: '正在核对需要转换的数据…', stopping: '正在正常停止旧版服务…', preparing_environment: '正在核验并恢复工作依赖…', switching: '正在切换旧安装，原数据保留…', converting: '正在转换已备份的数据范围…' }
function failure(error: unknown) {
  const code = (error as { code?: string })?.code
  if (code === 'CRABOT_UPDATE_SPACE' || code === 'ENOSPC') return '磁盘空间不足。已保留原目录，请释放空间后重试，或选择其他安装位置。'
  if (code === 'CRABOT_INSTALL_FILESYSTEM') return '请选择支持私有文件权限的本机持久卷。网络、临时或不支持的磁盘不能用于此安装。'
  if (code === 'CRABOT_CORE_INTEGRITY') return '离线安装包不完整或已改变。请重新获取完整安装包后重试。'
  if (code === 'CRABOT_INSTALL_SYSTEM_MODE') return '此机器由管理员统一部署，请通过浏览器或渠道使用 Crabot。桌面安装未更改任何实例。'
  if (code === 'CRABOT_DESKTOP_TAKEOVER_REQUIRED') return '检测到已有 Crabot 部署，需要沿用原安装位置进行接管。原数据已保留，未创建新实例。'
  if (code === 'CRABOT_DESKTOP_INSTALLATION' && error instanceof Error && error.message.length <= 512) return error.message
  if (code === 'CRABOT_DESKTOP_PROGRAM_REFERENCES') return '原 Crabot 程序仍在使用或尚未确认退出。请先关闭原应用和相关程序，再使用此安装包继续。'
  if (code === 'CRABOT_DESKTOP_REMOVAL') return '保留数据修复尚未完成。原数据和维护记录已保留，请在原安装位置使用对应离线安装包继续。'
  if (code === 'CRABOT_LEGACY_UNSUPPORTED' && error instanceof Error && error.message.length <= 512) return error.message
  if (code === 'CRABOT_MAINTENANCE_PENDING') {
    const reason = (error as { cause?: { code?: string } })?.cause?.code
    if (reason === 'CRABOT_LEGACY_RUNTIME_UNVERIFIED') return '无法确认旧版服务的运行状态，接管未完成。原数据和记录已保留。诊断代码：CRABOT_LEGACY_RUNTIME_UNVERIFIED'
    if (reason === 'CRABOT_LEGACY_STOP_UNKNOWN') return '旧版服务的停止结果尚未确认，接管未完成。原数据和记录已保留。诊断代码：CRABOT_LEGACY_STOP_UNKNOWN'
    return '旧安装接管尚未核验完成，原数据和保护记录已保留。请在原安装位置使用同一安装包继续。'
  }
  if (code === 'CRABOT_INSTALL_REGISTRATION') return '系统应用入口与已有文件冲突。原文件已保留，请核对原安装后重试。'
  return '安装尚未完成，现有文件和准备记录已保留。请核对所选位置及访问权限，再使用同一安装包继续。'
}
async function boot() {
  const profile = mkdtempSync(path.join(tmpdir(), 'crabot-installer-'))
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
  const discoveryRoot = locator?.install_root || path.join(homedir(), '.crabot')
  let legacyRequired = false, detectedLegacy: LegacyTakeoverSource | null = null, discoveryError: unknown
  const { discoverUserSourceDeployment } = await import(pathToFileURL(path.join(directory, 'bootstrap/scripts/lib/source-installation.mjs')).href)
  const sourceDeployment = !locator && discoverUserSourceDeployment({ home: homedir(), source: process.env })
  if (!sourceDeployment) {
    try { detectedLegacy = await discoverLegacyTakeover(discoveryRoot) }
    catch (error) { legacyRequired = true; discoveryError = error }
  }
  if (detectedLegacy) { legacyRequired = true; selected = detectedLegacy.installation.installRoot; preselected = true }
  if (!locator && !detectedLegacy && !sourceDeployment) {
    const { assertFreshUserInstallation } = await import(pathToFileURL(path.join(directory, 'bootstrap/scripts/lib/legacy-desktop.mjs')).href)
    try { await assertFreshUserInstallation({ home: homedir(), source: process.env }) }
    catch (error) {
      if ((error as { code?: string }).code !== 'CRABOT_DESKTOP_TAKEOVER_REQUIRED') throw error
      legacyRequired = true
    }
  }
  if (legacyRequired && !detectedLegacy) {
    if (!preselected) selected = discoveryRoot
    const choice = await dialog.showMessageBox({ type: 'info', title: '核对已有 Crabot',
      message: '发现已有数据或安装记录，尚未核实可接管的安装来源。',
      detail: `已检查位置：${discoveryRoot}\n${discoveryError ? failure(discoveryError) + '\n' : ''}只有已支持的标准旧发行可自动接管。源码部署不支持此安装器自动转换，请退出并保留原部署。若原来使用标准发行，请选择包含程序入口的原安装文件夹，不是 data 或 workspace。原数据未作修改。`,
      buttons: ['选择原位置', '退出安装'], defaultId: 0, cancelId: 1 })
    if (choice.response !== 0) return
  }
  const welcome = preselected || legacyRequired ? { response: 0 } : await dialog.showMessageBox({ type: 'info', title: '安装 Crabot', message: '欢迎安装 Crabot',
    detail: '已包含运行环境，无需额外安装。主要程序和数据将保存在你选择的安装文件夹；工作区可在安装后调整。', buttons: ['继续', '退出'], defaultId: 0, cancelId: 1 })
  if (welcome.response !== 0) return
  while (true) {
    const chosen = preselected ? { canceled: false, filePaths: [selected] } : await dialog.showOpenDialog({ title: legacyRequired ? '选择原 Crabot 安装文件夹' : '选择 Crabot 安装文件夹', defaultPath: selected, buttonLabel: legacyRequired ? '选择此目录' : '安装到这里', properties: ['openDirectory', 'showHiddenFiles', 'createDirectory'] })
    preselected = false
    if (chosen.canceled || chosen.filePaths.length !== 1) return
    selected = chosen.filePaths[0]
    let legacy: LegacyTakeoverSource | null
    try { legacy = await discoverLegacyTakeover(selected) }
    catch (error) {
      const choice = await dialog.showMessageBox({ type: 'error', title: '尚未确认原安装', message: failure(error), detail: '请选择可核实的标准旧发行安装文件夹；源码或不支持的来源请退出并保留原部署。已有数据未作修改。', buttons: ['重新选择', '退出安装'], defaultId: 0, cancelId: 1 })
      if (choice.response !== 0) return
      continue
    }
    if (legacyRequired && !legacy) {
      const choice = await dialog.showMessageBox({ type: 'error', title: '请选择原安装位置', message: '未能识别此位置的旧版 Crabot 程序入口。', detail: '这不表示文件夹为空。请选择原安装根目录（通常包含 VERSION 和 cli.mjs），不要选择 data、workspace 或新的空文件夹。已有文件未作修改。', buttons: ['重新选择', '退出安装'], defaultId: 0, cancelId: 1 })
      if (choice.response !== 0) return
      continue
    }
    const retainedState = await inspectRetainedDesktopRemoval(selected), removal = retainedState?.record
    if (retainedState?.canContinue) {
      const action = await dialog.showMessageBox({ type: 'question', title: '卸载尚未完成', message: '检测到上次卸载中断，数据已保留。',
        detail: `安装位置：${selected}\n可以保留数据重新安装，或继续移除本安装的程序和系统入口。`,
        buttons: ['保留数据重新安装', '继续卸载', '取消'], defaultId: 0, cancelId: 2, noLink: true })
      if (action.response === 2) return
      if (action.response === 1) {
        const { startInstallerRemovalFromSource } = await import('./removal-source.js')
        await startInstallerRemovalFromSource({ installRoot: selected, operationId: removal.operation_id, installerPayload: payload })
        exitCode = 0
        return
      }
    }
    const confirmation = legacy
      ? await dialog.showMessageBox({ type: 'question', title: '接管已有 Crabot', message: '升级这份已有安装，并保留原数据？',
        detail: `原版本：${legacy.installation.version}\n安装位置：${legacy.installation.installRoot}\n数据位置：${legacy.installation.dataRoot}\n将正常停止旧服务，保留模型配置、历史、工作区和依赖。完成后 GUI 与原命令共用同一实例；服务仍需启动核验。`,
        buttons: ['接管并保留数据', '重新选择', '取消'], defaultId: 0, cancelId: 2 })
      : await dialog.showMessageBox({ type: 'question', title: '安装位置', message: '将 Crabot 安装到所选文件夹？', detail: selected,
        buttons: ['安装', '重新选择', '取消'], defaultId: 0, cancelId: 2 })
    if (confirmation.response === 2) return
    if (confirmation.response !== 0) continue
    const abort = new AbortController(), progress = createInstallationProgressWindow(abort)
    let installed: { executable: string; dataDir: string } | undefined, verificationPending = false
    try {
      await progress.ready
      const registerEntries = (prepared: PreparedInstallation) => registerInstallationEntries(prepared, { home: homedir(), platform: process.platform, env: process.env, shell })
      if (legacy) {
        installed = await installLegacyTakeover({ payload, source: legacy, signal: abort.signal, registerEntries,
          progress: phase => progress.update(labels[phase] || '正在核验接管结果…', !['switching', 'converting', 'handing-off'].includes(phase)) })
        verificationPending = true
      } else {
        const retained = await prepareRetainedDesktopReinstall({ payload, installRoot: selected, signal: abort.signal,
          registerEntries: (prepared, operationId) => registerRetainedInstallationEntries(prepared, { home: homedir(), platform: process.platform, env: process.env, shell, operationId }),
          progress: phase => progress.update(labels[phase] || '正在核验安装结果…', phase !== 'handing-off') })
        if (retained) { installed = retained; verificationPending = true }
        else {
          const prepared: PreparedInstallation = preparedSchema.parse(await backend.prepareDesktopInstallation({ payload, installRoot: selected, signal: abort.signal,
            progress: (phase: string) => progress.update(labels[phase] || '正在核验安装结果…') }))
          progress.update('正在注册系统应用入口…', false)
          await registerEntries(prepared)
          installed = await backend.commitDesktopInstallation(prepared)
        }
      }
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
    const complete = await dialog.showMessageBox({ type: 'info', title: verificationPending ? '继续恢复服务' : '安装完成',
      message: verificationPending ? '程序已修复，原数据已保留。服务尚待启动核验。' : 'Crabot 已安装',
      detail: verificationPending ? '打开 Crabot 后会核对必要的数据转换和服务健康；未通过前不会解除维护保护。也可以稍后从应用入口继续。' : '现在可以打开应用，完成模型配置并开始使用。',
      buttons: verificationPending ? ['打开 Crabot 继续核验', '稍后继续'] : ['打开 Crabot', '完成'], defaultId: 0, cancelId: 1 })
    if (complete.response === 0 && installed) {
      const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: installed.dataDir }
      for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET', 'CRABOT_HOME']) delete env[name]
      try {
        const child = spawn(installed.executable, [], { env, detached: true, stdio: 'ignore' })
        await once(child, 'spawn'); child.unref()
      } catch { await dialog.showMessageBox({ type: 'error', title: '应用尚未启动', message: verificationPending ? '服务尚未核验，请从系统应用入口打开 Crabot 继续。原数据和维护保护已保留。' : 'Crabot 已安装，可从系统应用入口重新打开。' }) }
    }
    return
  }
}
app.on('window-all-closed', () => { /* Native dialogs own the installer lifetime. */ })
void boot().catch(async error => { exitCode = 1; if (!app.isReady()) await app.whenReady(); await dialog.showMessageBox({ type: 'error', title: '安装尚未完成', message: failure(error) }) }).finally(() => app.exit(exitCode))
