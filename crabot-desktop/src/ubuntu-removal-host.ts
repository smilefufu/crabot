// Fixed plain-Node owner. GTK displays bounded text and fixed choices only;
// stop, source exit, rules and program cleanup remain under the existing job.
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import type { RemovalRequest } from './removal-request.js'
import type { createUbuntuRemovalProgressWindow, RemovalDialogKind } from './ubuntu-removal-progress.js'
const require = createRequire(import.meta.url)
const load = (name: string) => import(new URL('./' + name, import.meta.url).href)
const fail = (): never => { throw Object.assign(new Error('独立Node卸载入口无法核验，用户数据已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
const displayText = (text: string) => {
  if (text.length <= 512) return text
  let result = ''
  for (const character of text) { if (result.length + character.length > 500) break; result += character }
  return result + '…'
}

export async function runUbuntuRemovalHost(request: RemovalRequest): Promise<'completed' | 'cancelled' | 'retained'> {
  if (process.platform !== 'linux' || request.existing || process.getuid!() === 0 || process.getuid!() !== process.geteuid!()) return fail()
  const management = require('./bootstrap/scripts/lib/desktop-management.cjs')
  const directory = management.requirePrivateDataRoot(path.dirname(fs.realpathSync(process.execPath)))
  if (path.basename(process.execPath) !== 'node' || fs.realpathSync(process.cwd()) !== directory
    || !/^crabot-removal-host-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(path.basename(directory))) return fail()
  const job = await load('bootstrap/scripts/lib/desktop-removal-job.mjs')
  const { readDesktopRemovalProof } = await load('bootstrap/scripts/lib/desktop-removal-proof.mjs')
  const { createUbuntuRemovalProgressWindow: openWindow }: { createUbuntuRemovalProgressWindow: typeof createUbuntuRemovalProgressWindow } = await load('progress.mjs')
  const { prepareUbuntuRemovalRules } = await load('rules.mjs'), { removeDesktopUserEntries } = await load('entries.mjs')
  const { runRemovalOperation } = await load('operation.mjs')
  const own = require('./bootstrap/scripts/lib/desktop-installation.cjs').readDesktopInstallation(request.installRoot)
  let activeAbort = new AbortController(), lease: any, firstDisplay = true
  const cancel = (value: unknown) => {
    if (value && typeof value === 'object' && Object.keys(value).length === 1 && (value as { kind?: unknown }).kind === 'desktop_removal_cancel') activeAbort.abort()
  }
  process.on('message', cancel)
  try {
    lease = await job.beginInitialDesktopRemovalNode({ installRoot: own.root, operationId: request.operationId, signal: activeAbort.signal,
      preparePlatformRemoval: () => prepareUbuntuRemovalRules({ installRoot: own.root, operationId: request.operationId, signal: activeAbort.signal }) })
    const { proof } = await readDesktopRemovalProof(own.root), frontend = proof.payload.gui['resources/crabot-maintenance']
    const open = (abort: AbortController) => openWindow({ directory, frontend, abort })
    const choose = async (kind: RemovalDialogKind, detail: string) => {
      const window = await open(new AbortController())
      try { window.update(displayText(detail), false); return await window.choose(kind) }
      finally { await window.close() }
    }
    const result = await runRemovalOperation({ lease,
      openProgress: async (abort: AbortController) => {
        const admissionCancelled = firstDisplay && activeAbort.signal.aborted; firstDisplay = false; activeAbort = abort
        if (admissionCancelled) abort.abort()
        const window = await open(abort)
        try { if (process.connected) process.send?.({ kind: 'desktop_removal_host_ready', operation_id: request.operationId }, () => {}) } catch {}
        return window
      },
      decide: async ({ canCancel, code }: { canCancel: boolean; code: string }) => {
        const decision = await choose(canCancel ? 'retry-cancel' : 'retry-repair', `退出会保留当前作业及用户数据，不会自动启动服务。诊断代码：${code}`)
        if (decision === 'repair') { await choose('repair', `请选择原安装位置：${own.root}。关闭维护界面后由离线安装器核验并恢复原数据。`); return 'close' }
        return decision
      },
      removeEntries: () => removeDesktopUserEntries({ installRoot: own.root, operationId: request.operationId, home: homedir(), env: process.env }),
      finish: () => job.finishDesktopRemoval({ installRoot: own.root, operationId: request.operationId }),
    })
    if (result === 'completed') {
      const retained = `保留数据位置：${own.dataDir}。工作区和工作依赖同样保留，可用同版或更高版离线安装器恢复。`
      let detail = retained
      while (await choose('completed', detail) === 'reveal') {
        const { runUbuntuProcess, ubuntuDesktopEnvironment } = await import('./ubuntu-process.js')
        const opened = await runUbuntuProcess('/usr/bin/xdg-open', [own.dataDir], ubuntuDesktopEnvironment(process.env), 15000, new AbortController().signal)
        detail = opened.code === 0 ? retained : `无法打开文件管理器。数据仍保留在：${own.dataDir}`
      }
    } else if (result === 'cancelled') await choose('cancelled', '共享服务不会自动重启。需要继续使用时，请从正常应用入口启动。')
    return result
  } finally { process.removeListener('message', cancel); lease?.close() }
}
