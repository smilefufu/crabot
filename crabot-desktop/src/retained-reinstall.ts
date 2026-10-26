// Existing retained installation only. Ordinary target GUI recovery owns service
// startup, data conversion and health after this installer prepares the handoff.
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { PreparedInstallation } from './installation-entries.js'
const load = (name: string): Promise<any> => import(new URL('./bootstrap/scripts/lib/' + name, import.meta.url).href)
export async function prepareRetainedDesktopReinstall(options: {
  payload: string; installRoot: string; signal: AbortSignal
  registerEntries: (prepared: PreparedInstallation) => Promise<void>
  progress: (phase: string) => void
}): Promise<{ executable: string; dataDir: string; verification_pending: true; health_verified: false } | null> {
  try { await lstat(path.join(options.installRoot, '.desktop-removal.json')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  const { readDesktopRemoval } = await load('desktop-removal-record.cjs')
  const record = readDesktopRemoval(options.installRoot)
  if (!record || !['removing', 'completed'].includes(record.phase)) throw Object.assign(new Error('卸载尚未进入程序移除阶段，请先在原应用中取消或继续卸载。'), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  const { prepareDesktopRemovalReinstall } = await load('desktop-reinstall.mjs')
  const { readDesktopRemovalProof } = await load('desktop-removal-proof.mjs')
  const { assertDesktopRemovalProgramsUnused } = await load('desktop-removal-delete.mjs')
  const verifyStopped = async () => {
    const { proof } = await readDesktopRemovalProof(options.installRoot)
    await assertDesktopRemovalProgramsUnused({ installRoot: options.installRoot, proof }, 'reinstall')
  }
  await prepareDesktopRemovalReinstall({ ...options, operationId: record.operation_id, verifyStopped })
  options.signal.throwIfAborted()
  options.progress('handing-off')
  const { runPreparedDesktopReinstallHandoff } = await load('desktop-reinstall-data.mjs')
  return runPreparedDesktopReinstallHandoff({ payload: options.payload, installRoot: options.installRoot,
    operationId: record.operation_id, registerEntries: options.registerEntries })
}
