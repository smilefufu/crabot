// Worker stop policy: stable full identities and submission receipts, never closure or exit proof.
import { createWorkspaceJournalClient, serveWorkspaceJournal, journalFields as fields, workspaceJournalFailure as failure } from './workspace-coordinator-journal.mjs'
import { readWorkspaceRelocationWorkers, readWorkspaceRelocationStops, commitWorkspaceRelocationWorkers,
  prepareWorkspaceRelocationStops, completeWorkspaceRelocationStops } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson } from '../../crabot-shared/dist/canonical-json.js'

const sortedResults = results => [...results].sort((a, b) => {
  if (a.worker_id !== b.worker_id) return a.worker_id < b.worker_id ? -1 : 1
  if (a.incarnation_id !== b.incarnation_id) return a.incarnation_id < b.incarnation_id ? -1 : 1
  return 0
})
export function createWorkspaceWorkerJournal(coordinator, context) {
  const { dataDir, id } = context, transport = createWorkspaceJournalClient(coordinator, context, 'worker')
  const acknowledged = async (operation, payload) => {
    try {
      let material = payload
      if (operation === 'complete') material = { results: sortedResults(payload.results) }
      const expected = sha256CanonicalJson(material)
      const hadAttempt = operation === 'prepare' && readWorkspaceRelocationWorkers(dataDir, id)
        ? Boolean(readWorkspaceRelocationStops(dataDir, id).attempt) : false
      const result = await transport.call(operation, payload)
      const validResult = operation === 'prepare' ? result === 'dispatch' || result === 'observe' : result === true
      if (!validResult) throw failure()
      if (operation === 'capture') {
        const fixed = readWorkspaceRelocationWorkers(dataDir, id)
        if (!fixed || sha256CanonicalJson({ workers: fixed.workers }) !== expected) throw failure()
      } else {
        const actual = readWorkspaceRelocationStops(dataDir, id)
        if (operation === 'prepare') {
          if (!actual.attempt || hadAttempt && result === 'dispatch'
            || sha256CanonicalJson({ workers: readWorkspaceRelocationWorkers(dataDir, id).workers }) !== expected) throw failure()
        } else if (!actual.submission || sha256CanonicalJson({ results: actual.submission.results }) !== expected) throw failure()
      }
      transport.verify()
      return result
    } catch { transport.close(); throw failure() }
  }
  return Object.freeze({ capture: async workers => { await acknowledged('capture', { workers }) }, prepare: workers => acknowledged('prepare', { workers }),
    complete: async results => { await acknowledged('complete', { results }) }, close: transport.close })
}
export function serveWorkspaceWorkerJournal(context) {
  const args = { dataDir: context.dataDir, id: context.id }
  return serveWorkspaceJournal(context, 'worker', {
    capture(payload) {
      if (!fields(payload, ['workers'])) throw failure()
      commitWorkspaceRelocationWorkers({ ...args, workers: payload.workers })
      return true
    },
    prepare(payload) {
      if (!fields(payload, ['workers'])) throw failure()
      commitWorkspaceRelocationWorkers({ ...args, workers: payload.workers })
      return prepareWorkspaceRelocationStops({ ...args, workers: payload.workers }).dispatch
    },
    complete(payload) {
      if (!fields(payload, ['results'])) throw failure()
      completeWorkspaceRelocationStops({ ...args, results: payload.results })
      return true
    },
  })
}
