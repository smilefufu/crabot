// Ordinary GUI source only. This prepares a private copy and validates its exit
// intent; it never publishes a removal job or deletes installed program files.
import { app, dialog } from 'electron'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createRemovalProgressWindow } from './removal-progress-window.js'
import { removalHostArgument } from './removal-request.js'
const require = createRequire(import.meta.url)
const load = (file: string) => import(new URL('./bootstrap/scripts/lib/' + file, import.meta.url).href)
const generation = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')

type SourceOptions = { installRoot: string; operationId: string; beginExit: () => () => void }
let active: Promise<void> | undefined
export function startGuiRemovalFromSource(options: SourceOptions): Promise<void> {
  return active ||= removeFromSource(options).finally(() => { active = undefined })
}
async function removeFromSource(options: SourceOptions) {
  if (!app.isPackaged || !['darwin', 'win32'].includes(process.platform)) throw Object.assign(new Error('需要已安装的本机应用入口。'), { code: 'CRABOT_DESKTOP_REMOVAL' })
  const own = require('./bootstrap/scripts/lib/desktop-installation.cjs').readDesktopInstallation(options.installRoot)
  const { readDesktopRemoval } = require('./bootstrap/scripts/lib/desktop-removal-record.cjs')
  const previous = readDesktopRemoval(own.root), operationId = previous?.operation_id ?? options.operationId
  const answer = await dialog.showMessageBox({ type: 'question', title: '卸载 Crabot', message: previous ? '继续本次卸载？' : '卸载 Crabot 并保留数据？',
    detail: `安装位置：${own.root}\n将移除本安装的应用、Core 和系统入口。\n保留数据：${own.dataDir}\n工作区和工作依赖保留。共享服务及正在进行的任务将按正常退出停止。程序删除开始前可取消。`,
    buttons: ['取消', previous ? '继续卸载' : '卸载并保留数据'], defaultId: 0, cancelId: 0, noLink: true })
  if (answer.response !== 1) return
  const abort = new AbortController(), progress = createRemovalProgressWindow(abort)
  let prepared: any, directoryId: string | undefined, child: ReturnType<typeof spawn> | undefined, restoreExit: (() => void) | undefined
  const closeProgress = () => progress.close()
  const cancelChild = () => { try { if (child?.connected) child.send({ kind: 'desktop_removal_cancel' }, () => {}) } catch {} }
  try {
    await progress.ready; abort.signal.throwIfAborted()
    const backend = await load('desktop-removal-host.mjs')
    progress.update('正在准备独立维护界面；用户数据不会复制或删除…')
    prepared = await (previous ? backend.prepareExistingDesktopRemovalGui : backend.prepareDesktopRemovalGui)({
      installRoot: own.root, operationId, signal: abort.signal,
      progress: () => progress.update('正在核验独立维护程序，完成后正常停止共享服务…'),
    })
    directoryId = generation(fs.lstatSync(prepared.directory, { bigint: true }))
    abort.signal.throwIfAborted()
    const env = { ...process.env }
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET']) delete env[key]
    child = spawn(prepared.executable, [removalHostArgument({ installRoot: own.root, operationId, existing: !!previous })], {
      env, cwd: prepared.directory, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    const stopped = new Promise<number | null>((resolve, reject) => { child!.once('error', reject); child!.once('close', code => resolve(code)) })
    void stopped.catch(() => {})
    await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject) })
    const cleanup: () => Promise<void> = (await load('desktop-removal-host-cleanup.mjs')).captureRemovalGuiCleanup(prepared, child)
    const source = await load('desktop-removal-source.mjs')
    const verifyExit = (previous ? source.createExistingRemovalSourceExitVerifier : source.createDesktopRemovalSourceExitVerifier)({ installRoot: own.root, prepared, child })
    abort.signal.addEventListener('abort', cancelChild)
    if (abort.signal.aborted) cancelChild()
    child.on('message', value => {
      const message = value as { kind?: string; operation_id?: string }
      if (message?.kind === 'desktop_removal_host_ready' && message.operation_id === operationId) { closeProgress(); return }
      if (message?.kind !== 'desktop_removal_source_exit') return
      void verifyExit(message).then((accepted: boolean) => {
        if (!accepted || abort.signal.aborted) return
        restoreExit = options.beginExit()
        try { app.quit() } catch (error) { restoreExit(); throw error }
      }).catch(() => { /* The child retains its stopping job and shows a bounded retry. */ })
    })
    const code = await stopped
    closeProgress()
    await cleanup()
    if (code !== 0) throw Object.assign(new Error('独立维护界面退出，原卸载进度与数据已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' })
  } catch (error) {
    // Before a child ever starts, this fresh in-memory copy has no executable
    // owner. A running or unidentified child always retains its diagnostic copy.
    if (prepared && !child?.pid && directoryId) {
      const management = require('./bootstrap/scripts/lib/desktop-management.cjs')
      if (management.requirePrivateDataRoot(prepared.directory) === prepared.directory
        && generation(fs.lstatSync(prepared.directory, { bigint: true })) === directoryId) await fs.promises.rm(prepared.directory, { recursive: true })
    }
    if (!abort.signal.aborted || child?.pid || error instanceof AggregateError) throw error
  } finally { abort.signal.removeEventListener('abort', cancelChild); closeProgress(); restoreExit?.() }
}
