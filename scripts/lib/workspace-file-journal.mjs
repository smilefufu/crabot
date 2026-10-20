// Fixed file preparation policy; no caller-supplied paths or file effects are accepted here.
import { createWorkspaceJournalClient, serveWorkspaceJournal, journalFields as fields, workspaceJournalFailure as failure } from './workspace-coordinator-journal.mjs'
import { readWorkspaceRelocationFilePlan, prepareWorkspaceRelocationFilePlan } from './workspace-relocation-intent.mjs'
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
    close: transport.close,
  })
}
export function serveWorkspaceFileJournal(context) {
  const controller = new AbortController()
  const transport = serveWorkspaceJournal(context, 'file', {
    async prepare(payload) {
      if (!fields(payload, [])) throw failure()
      const result = await prepareWorkspaceRelocationFilePlan({ dataDir: context.dataDir, id: context.id, signal: controller.signal })
      return { dispatch: result.dispatch, plan_sha256: sha256CanonicalJson(result.plan) }
    },
  })
  return Object.freeze({ close() { controller.abort(); transport.close() } })
}
