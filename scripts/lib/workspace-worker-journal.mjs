// Fixed Agent maintenance: Worker stop receipts and closure, followed by immutable Manager recovery scope.
import { createWorkspaceJournalClient, serveWorkspaceJournal, journalFields as fields, workspaceJournalFailure as failure } from './workspace-coordinator-journal.mjs'
import { readWorkspaceRelocationWorkers, readWorkspaceRelocationStops, commitWorkspaceRelocationWorkers,
  readWorkspaceRelocationProcesses, commitWorkspaceRelocationProcesses,
  prepareWorkspaceRelocationStops, completeWorkspaceRelocationStops, readWorkspaceRelocationClosureBindings, verifyWorkspaceRelocationClosureReadiness, readWorkspaceRelocationClosurePlan, readWorkspaceRelocationClosureCommit, readWorkspaceRelocationRecoveryPlan } from './workspace-relocation-intent.mjs'
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
      } else if (operation === 'capture_processes') {
        const fixed = readWorkspaceRelocationProcesses(dataDir, id)
        if (!fixed || sha256CanonicalJson({ processes: fixed.processes }) !== expected) throw failure()
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
  return Object.freeze({ capture: async workers => { await acknowledged('capture', { workers }) },
    captureProcesses: async processes => { await acknowledged('capture_processes', { processes }) }, prepare: workers => acknowledged('prepare', { workers }),
    complete: async results => { await acknowledged('complete', { results }) },
    async prepareClosure() {
      try {
        const previous = readWorkspaceRelocationClosurePlan(dataDir, id), result = await transport.call('prepare_closure', {})
        const plan = readWorkspaceRelocationClosurePlan(dataDir, id)
        if (!plan || !fields(result, ['dispatch', 'plan_sha256']) || !['dispatch', 'observe'].includes(result.dispatch)
          || previous && result.dispatch !== 'observe' || result.plan_sha256 !== sha256CanonicalJson(plan)) throw failure()
        transport.verify()
        return { dispatch: result.dispatch, plan }
      } catch { transport.close(); throw failure() }
    },
    async commitClosure() {
      try {
        const previous = readWorkspaceRelocationClosureCommit(dataDir, id), result = await transport.call('commit_closure', {})
        const complete = readWorkspaceRelocationClosureCommit(dataDir, id)
        if (!complete || !fields(result, ['dispatch', 'closed_ledgers', 'commit_sha256']) || !['dispatch', 'observe'].includes(result.dispatch)
          || previous && result.dispatch !== 'observe' || result.closed_ledgers !== complete.receipts.length
          || result.commit_sha256 !== sha256CanonicalJson(complete)) throw failure()
        transport.verify()
        return { dispatch: result.dispatch, complete }
      } catch { transport.close(); throw failure() }
    },
    async prepareRecovery() {
      try {
        const previous = readWorkspaceRelocationRecoveryPlan(dataDir, id), result = await transport.call('prepare_recovery', {})
        const plan = readWorkspaceRelocationRecoveryPlan(dataDir, id)
        if (!plan || !fields(result, ['dispatch', 'plan_sha256']) || !['dispatch', 'observe'].includes(result.dispatch)
          || previous && result.dispatch !== 'observe' || result.plan_sha256 !== sha256CanonicalJson(plan)) throw failure()
        transport.verify()
        return { dispatch: result.dispatch, plan_sha256: result.plan_sha256 }
      } catch { transport.close(); throw failure() }
    },
    async verifyClosureReadiness() {
      try {
        const result = await transport.call('verify_closure_readiness', {}), bindings = readWorkspaceRelocationClosureBindings(dataDir, id)
        if (!fields(result, ['verified', ...Object.keys(bindings)]) || result.verified !== true
          || sha256CanonicalJson(result) !== sha256CanonicalJson({ verified: true, ...bindings })) throw failure()
        transport.verify()
        return Object.freeze(result)
      } catch { transport.close(); throw failure() }
    }, close: transport.close })
}
export function serveWorkspaceWorkerJournal(context) {
  const args = { dataDir: context.dataDir, id: context.id }
  let closurePreparation, closureCommit, recoveryPreparation
  return serveWorkspaceJournal(context, 'worker', {
    async prepare_closure(payload) {
      if (!fields(payload, [])) throw failure()
      await verifyWorkspaceRelocationClosureReadiness(args)
      const previous = closurePreparation
      if (!closurePreparation) closurePreparation = (async () => {
        const agent = await import('../../crabot-agent/dist/core/workspace-relocation-closure.js')
        return agent.prepareWorkspaceRelocationClosure(args)
      })()
      const result = await closurePreparation
      return { dispatch: previous ? 'observe' : result.dispatch, plan_sha256: result.plan_sha256 }
    },
    async commit_closure(payload) {
      if (!fields(payload, [])) throw failure()
      await verifyWorkspaceRelocationClosureReadiness(args)
      if (closurePreparation) await closurePreparation
      if (!readWorkspaceRelocationClosurePlan(args.dataDir, args.id)) throw failure()
      const previous = closureCommit
      if (!closureCommit) closureCommit = (async () => {
        const agent = await import('../../crabot-agent/dist/core/workspace-relocation-closure.js')
        return agent.commitWorkspaceRelocationClosure(args)
      })()
      const result = await closureCommit
      return { ...result, dispatch: previous ? 'observe' : result.dispatch }
    },
    async prepare_recovery(payload) {
      if (!fields(payload, [])) throw failure()
      await verifyWorkspaceRelocationClosureReadiness(args)
      if (closureCommit) await closureCommit
      if (!readWorkspaceRelocationClosureCommit(args.dataDir, args.id)) throw failure()
      const previous = recoveryPreparation
      if (!recoveryPreparation) recoveryPreparation = (async () => {
        const agent = await import('../../crabot-agent/dist/core/workspace-relocation-recovery.js')
        return agent.prepareWorkspaceRelocationRecovery(args)
      })()
      const result = await recoveryPreparation
      return { dispatch: previous ? 'observe' : result.dispatch, plan_sha256: result.plan_sha256 }
    },
    async verify_closure_readiness(payload) {
      if (!fields(payload, [])) throw failure()
      return verifyWorkspaceRelocationClosureReadiness(args)
    },
    capture(payload) {
      if (!fields(payload, ['workers'])) throw failure()
      commitWorkspaceRelocationWorkers({ ...args, workers: payload.workers })
      return true
    },
    capture_processes(payload) {
      if (!fields(payload, ['processes'])) throw failure()
      commitWorkspaceRelocationProcesses({ ...args, processes: payload.processes })
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
