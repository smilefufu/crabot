// Existing retained installation only. Ordinary target GUI recovery owns service
// startup, data conversion and health after this installer prepares the handoff.
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { PreparedInstallation } from './installation-entries.js'
const load = (name: string): Promise<any> => import(new URL('./bootstrap/scripts/lib/' + name, import.meta.url).href)
// Read-only UI facts. An interrupted repair must resume repair; its newly
// prepared programs are outside the original uninstall proof's deletion scope.
export async function inspectRetainedDesktopRemoval(installRoot: string): Promise<{ record: any; canContinue: boolean } | null> {
  const exists = async (file: string) => {
    try { await lstat(file); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  if (!await exists(path.join(installRoot, '.desktop-removal.json'))) return null
  const { readDesktopRemoval } = await load('desktop-removal-record.cjs')
  const installation = await load('desktop-installation.cjs')
  const own = installation.readDesktopInstallation(installRoot), record = readDesktopRemoval(own.root)
  const pending = await Promise.all([path.join(own.root, '.desktop-installing.json'), path.join(own.dataDir, 'desktop-maintenance.json')].map(exists))
  const selected = installation.readDesktopPairReference(own.root).selection
  return { record, canContinue: record.phase === 'removing' && !pending.some(Boolean)
    && JSON.stringify(selected) === JSON.stringify(record.source_selection) }
}

export async function prepareRetainedDesktopReinstall(options: {
  payload: string; installRoot: string; signal: AbortSignal
  registerEntries: (prepared: PreparedInstallation, operationId: string) => Promise<void>
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
    operationId: record.operation_id, registerEntries: (prepared: PreparedInstallation) => options.registerEntries(prepared, record.operation_id) })
}
