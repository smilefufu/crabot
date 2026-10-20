// CLI/background known-scope policy; never a Worker closure or global-exit permit.
import { createWorkspaceJournalClient, serveWorkspaceJournal, journalFields as fields, workspaceJournalFailure as failure } from './workspace-coordinator-journal.mjs'
import { readWorkspaceRelocationProcessStops, prepareWorkspaceRelocationProcessStops,
  observeWorkspaceRelocationProcesses, completeWorkspaceRelocationProcessStops } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson } from '../../crabot-shared/dist/canonical-json.js'

export function createWorkspaceProcessJournal(coordinator, context) {
  const { dataDir, id } = context, transport = createWorkspaceJournalClient(coordinator, context, 'process')
  const acknowledged = async (operation, payload) => {
    try {
      const hadAttempt = operation === 'prepare' && Boolean(readWorkspaceRelocationProcessStops(dataDir, id).attempt)
      const expected = sha256CanonicalJson(payload), result = await transport.call(operation, payload)
      const actual = readWorkspaceRelocationProcessStops(dataDir, id)
      if (operation === 'prepare') {
        if (!actual.attempt || !['dispatch', 'observe'].includes(result) || hadAttempt && result === 'dispatch') throw failure()
      } else if (result !== true || (operation === 'observe'
        ? sha256CanonicalJson({ processes: actual.observations.at(-1)?.processes }) !== expected : !actual.completion)) throw failure()
      transport.verify()
      return result
    } catch { transport.close(); throw failure() }
  }
  return Object.freeze({ prepare: () => acknowledged('prepare', {}),
    observe: async processes => { await acknowledged('observe', { processes }) },
    complete: async () => { await acknowledged('complete', {}) }, close: transport.close })
}
export function serveWorkspaceProcessJournal(context) {
  const args = { dataDir: context.dataDir, id: context.id }
  return serveWorkspaceJournal(context, 'process', {
    prepare(payload) {
      if (!fields(payload, [])) throw failure()
      return prepareWorkspaceRelocationProcessStops(args).dispatch
    },
    observe(payload) {
      if (!fields(payload, ['processes'])) throw failure()
      observeWorkspaceRelocationProcesses({ ...args, processes: payload.processes }); return true
    },
    complete(payload) {
      if (!fields(payload, [])) throw failure()
      completeWorkspaceRelocationProcessStops(args); return true
    },
  })
}
