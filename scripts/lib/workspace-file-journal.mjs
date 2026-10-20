// Fixed file preparation policy; no caller-supplied paths or file effects are accepted here.
import { createWorkspaceJournalClient, serveWorkspaceJournal, journalFields as fields, workspaceJournalFailure as failure } from './workspace-coordinator-journal.mjs'
import { readWorkspaceRelocationFilePlan, readWorkspaceRelocationFileActors, prepareWorkspaceRelocationFilePlan } from './workspace-relocation-intent.mjs'
import { launchWorkspaceFileHost } from './workspace-file-host.mjs'
import native from './process-identity.cjs'
import { sha256CanonicalJson } from '../../crabot-shared/dist/canonical-json.js'

export function createWorkspaceFileJournal(coordinator, context) {
  const transport = createWorkspaceJournalClient(coordinator, context, 'file')
  return Object.freeze({
    async prepare() {
      try {
        const previous = readWorkspaceRelocationFilePlan(context.dataDir, context.id)
        const result = await transport.call('prepare', {}), plan = readWorkspaceRelocationFilePlan(context.dataDir, context.id)
        if (!plan || !fields(result, ['dispatch', 'plan_sha256']) || !['dispatch', 'observe'].includes(result.dispatch)
          || previous && result.dispatch !== 'observe' || result.plan_sha256 !== sha256CanonicalJson(plan)) throw failure()
        transport.verify()
        return { dispatch: result.dispatch, plan }
      } catch { transport.close(); throw failure() }
    },
    async prepareHost() {
      try {
        const previous = readWorkspaceRelocationFileActors(context.dataDir, context.id)
        const result = await transport.call('prepare_host', {}), actors = readWorkspaceRelocationFileActors(context.dataDir, context.id)
        if (!actors.host || !actors.permission || !fields(result, ['dispatch', 'actors_sha256']) || !['dispatch', 'observe'].includes(result.dispatch)
          || previous.attempt && result.dispatch !== 'observe' || result.actors_sha256 !== sha256CanonicalJson(actors)
          || !native.sameProcess(actors.host.process, native.inspectProcess(actors.host.process.pid))) throw failure()
        transport.verify()
        return { dispatch: result.dispatch, actors }
      } catch { transport.close(); throw failure() }
    },
    close: transport.close,
  })
}
export function serveWorkspaceFileJournal(context) {
  const controller = new AbortController()
  let hostPreparation, host
  const disconnectHost = child => { if (child?.connected) { try { child.disconnect() } catch {} } }
  const transport = serveWorkspaceJournal(context, 'file', {
    async prepare_host(payload) {
      if (!fields(payload, [])) throw failure()
      const previous = hostPreparation
      if (!hostPreparation) hostPreparation = (async () => {
        const result = await launchWorkspaceFileHost({ dataDir: context.dataDir, id: context.id })
        if (controller.signal.aborted) { disconnectHost(result.child); throw failure() }
        if (result.dispatch !== 'dispatch' || !result.child) throw failure()
        host = result.child
        return sha256CanonicalJson(readWorkspaceRelocationFileActors(context.dataDir, context.id))
      })()
      const accepted = await hostPreparation, actors = readWorkspaceRelocationFileActors(context.dataDir, context.id)
      if (!host?.connected || host.exitCode !== null || host.signalCode !== null || sha256CanonicalJson(actors) !== accepted
        || !native.sameProcess(actors.host.process, native.inspectProcess(host.pid))) throw failure()
      return { dispatch: previous ? 'observe' : 'dispatch', actors_sha256: accepted }
    },
    async prepare(payload) {
      if (!fields(payload, [])) throw failure()
      const result = await prepareWorkspaceRelocationFilePlan({ dataDir: context.dataDir, id: context.id, signal: controller.signal })
      return { dispatch: result.dispatch, plan_sha256: sha256CanonicalJson(result.plan) }
    },
  })
  return Object.freeze({ close() { controller.abort(); transport.close(); disconnectHost(host) } })
}
