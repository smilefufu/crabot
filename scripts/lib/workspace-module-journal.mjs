// Module lifecycle policy stays separate from the neutral fixed-job IPC transport.
import { createWorkspaceJournalClient, serveWorkspaceJournal, journalFields as fields, workspaceJournalFailure as failure } from './workspace-coordinator-journal.mjs'
import { readWorkspaceRelocationModules, readWorkspaceRelocationModuleStops, commitWorkspaceRelocationModules, prepareWorkspaceRelocationModuleStops,
  observeWorkspaceRelocationModuleProcesses, completeWorkspaceRelocationModuleStops } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson } from '../../crabot-shared/dist/canonical-json.js'

export function createWorkspaceModuleJournal(coordinator, context) {
  const { dataDir, id } = context, transport = createWorkspaceJournalClient(coordinator, context, 'module')
  const acknowledged = async (operation, payload) => {
    try {
      let material = payload
      if (operation === 'complete') material = { results: [...payload.results].sort((a, b) => a.module_id < b.module_id ? -1 : a.module_id > b.module_id ? 1 : 0) }
      const expected = sha256CanonicalJson(material), moduleId = payload.module_id
      const hadAttempt = operation === 'prepare' && readWorkspaceRelocationModules(dataDir, id)
        ? Boolean(readWorkspaceRelocationModuleStops(dataDir, id).attempt) : false
      const result = await transport.call(operation, payload)
      const validResult = operation === 'prepare' ? result === 'dispatch' || result === 'observe' : result === true
      if (!validResult) throw failure()
      const actual = readWorkspaceRelocationModuleStops(dataDir, id)
      if (operation === 'prepare') {
        if (!actual.attempt || hadAttempt && result === 'dispatch'
          || sha256CanonicalJson({ modules: readWorkspaceRelocationModules(dataDir, id).modules }) !== expected) throw failure()
      } else if (operation === 'observe') {
        const latest = actual.observations.filter(item => item.module_id === moduleId).at(-1)
        if (!latest || sha256CanonicalJson({ module_id: moduleId, processes: latest.processes }) !== expected) throw failure()
      } else if (!actual.submission || sha256CanonicalJson({ results: actual.submission.results }) !== expected) throw failure()
      transport.verify()
      return result
    } catch { transport.close(); throw failure() }
  }
  return Object.freeze({
    prepare: modules => acknowledged('prepare', { modules }),
    observe: async (moduleId, processes) => { await acknowledged('observe', { module_id: moduleId, processes }) },
    complete: async results => { await acknowledged('complete', { results }) },
    close: transport.close,
  })
}

export function serveWorkspaceModuleJournal(context) {
  const args = { dataDir: context.dataDir, id: context.id }
  return serveWorkspaceJournal(context, 'module', {
    prepare(payload) {
      if (!fields(payload, ['modules'])) throw failure()
      commitWorkspaceRelocationModules({ ...args, modules: payload.modules })
      return prepareWorkspaceRelocationModuleStops({ ...args, modules: payload.modules }).dispatch
    },
    observe(payload) {
      if (!fields(payload, ['module_id', 'processes'])) throw failure()
      observeWorkspaceRelocationModuleProcesses({ ...args, moduleId: payload.module_id, processes: payload.processes })
      return true
    },
    complete(payload) {
      if (!fields(payload, ['results'])) throw failure()
      completeWorkspaceRelocationModuleStops({ ...args, results: payload.results })
      return true
    },
  })
}
