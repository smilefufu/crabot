// The fixed entry is the only static dependency before independent lock/readiness.
import { enterWorkspaceRelocationCoordinator } from './lib/workspace-coordinator-entry.mjs'

let context, worker, modules, closed = false
function close() {
  if (closed) return
  closed = true
  worker?.close(); modules?.close(); context?.release()
}
try {
  context = await enterWorkspaceRelocationCoordinator()
  process.once('disconnect', close)
  const [{ serveWorkspaceWorkerJournal }, { serveWorkspaceModuleJournal }, records, { sha256CanonicalJson }] = await Promise.all([
    import('./lib/workspace-worker-journal.mjs'), import('./lib/workspace-module-journal.mjs'),
    import('./lib/workspace-relocation-intent.mjs'), import('../crabot-shared/dist/canonical-json.js'),
  ])
  if (closed || !process.connected) throw new Error('Coordinator parent disconnected')
  worker = serveWorkspaceWorkerJournal(context); modules = serveWorkspaceModuleJournal(context)
  const current = records.readWorkspaceRelocationCoordinator(context.dataDir, context.id)
  if (!current.ready || sha256CanonicalJson(current.launch) !== sha256CanonicalJson(context.launch)) throw new Error('Coordinator readiness changed')
  await new Promise((resolve, reject) => process.send({ kind: 'workspace_relocation_handlers_ready', intent_id: context.id,
    launch_id: context.launch.launch_id, ready_sha256: sha256CanonicalJson(current.ready) }, error => error ? reject(error) : resolve()))
} catch {
  close(); process.exitCode = 1
  if (process.connected) process.disconnect()
}
