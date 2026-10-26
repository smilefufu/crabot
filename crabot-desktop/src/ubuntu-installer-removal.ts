// Existing destructive job only. The GTK installer already owns an independent
// Node; this never loads the removed Core or creates another environment copy.
import path from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { runRemovalOperation } from './removal-operation.js'
import { removeDesktopUserEntries } from './installation-removal.js'
import { prepareUbuntuInstallerRemovalRules } from './ubuntu-removal-rules.js'
const require = createRequire(import.meta.url)
const load = (name: string) => import(new URL('./bootstrap/scripts/lib/' + name, import.meta.url).href)
export async function runUbuntuInstallerRemoval(options: {
  payload: string; installRoot: string; operationId: string; signal: AbortSignal; progress: (message: string) => void
}): Promise<'completed' | 'retained'> {
  if (process.platform !== 'linux' || process.getuid!() === 0 || process.getuid!() !== process.geteuid!()) {
    throw Object.assign(new Error('需要 Ubuntu 普通用户的离线安装器入口。'), { code: 'CRABOT_DESKTOP_REMOVAL' })
  }
  options.signal.throwIfAborted()
  const bundle = path.dirname(options.payload)
  process.chdir(bundle)
  const own = require('./bootstrap/scripts/lib/desktop-installation.cjs').readDesktopInstallation(options.installRoot)
  const { resumeInstallerDesktopRemovalNode, finishDesktopRemoval } = await load('desktop-removal-job.mjs')
  // The job was already removing before the user chose continuation. Closing
  // the frontend cannot turn a partial deletion into cancellation or rollback.
  const operation = new AbortController()
  let lease: any
  lease = await resumeInstallerDesktopRemovalNode({ installRoot: own.root, operationId: options.operationId,
    installerPayload: options.payload, signal: options.signal,
    preparePlatformRemoval: () => prepareUbuntuInstallerRemovalRules({ installRoot: own.root, operationId: options.operationId,
      bundle, signal: operation.signal, verifyHost: () => lease.verifyHost() }) })
  const result = await runRemovalOperation({ lease,
    openProgress: async () => ({ update: message => options.progress(message), close: () => {} }),
    decide: async ({ code }) => { console.error('CRABOT_DESKTOP_REMOVAL', code); return 'close' },
    removeEntries: () => removeDesktopUserEntries({ installRoot: own.root, operationId: options.operationId, home: homedir(), env: process.env }),
    finish: () => finishDesktopRemoval({ installRoot: own.root, operationId: options.operationId }),
  })
  return result === 'completed' ? 'completed' : 'retained'
}
