// Fixed file preparation policy; no caller-supplied paths or file effects are accepted here.
import { createWorkspaceJournalClient, serveWorkspaceJournal, journalFields as fields, workspaceJournalFailure as failure } from './workspace-coordinator-journal.mjs'
import { readWorkspaceRelocationFilePlan, readWorkspaceRelocationFileActors, prepareWorkspaceRelocationFilePlan, prepareWorkspaceRelocationStaging, readWorkspaceRelocationRootPlan, prepareWorkspaceRelocationRootPlan, verifyWorkspaceRelocationClosureReadiness, readWorkspaceRelocationRecoveryCommit, readWorkspaceRelocationRootPublished, readWorkspaceRelocationRootSelected, publishWorkspaceRelocationRoot, selectWorkspaceRelocationRoot, verifyWorkspaceRelocationSelectedRoot, readWorkspaceRelocationClosureCommit, readWorkspaceRelocationHealth, recordWorkspaceRelocationHealth, prepareWorkspaceRelocationCompletion } from './workspace-relocation-intent.mjs'
import { launchWorkspaceFileHost, prepareWorkspaceFilesWithHost } from './workspace-file-host.mjs'
import native from './process-identity.cjs'
import { sha256CanonicalJson } from '../../crabot-shared/dist/canonical-json.js'

const hostAdmissionHash = actors => sha256CanonicalJson({ attempt: actors.attempt, host: actors.host, permission: actors.permission })

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
    async prepareStage() {
      try {
        const previous = readWorkspaceRelocationFileActors(context.dataDir, context.id).staging
        const result = await transport.call('prepare_stage', {}), staging = readWorkspaceRelocationFileActors(context.dataDir, context.id).staging
        if (!staging || !fields(result, ['dispatch', 'staging_sha256']) || !['dispatch', 'observe'].includes(result.dispatch)
          || previous && result.dispatch !== 'observe' || result.staging_sha256 !== sha256CanonicalJson(staging)) throw failure()
        transport.verify()
        return { dispatch: result.dispatch, staging }
      } catch { transport.close(); throw failure() }
    },
    async prepareFiles() {
      try {
        const previous = readWorkspaceRelocationFileActors(context.dataDir, context.id).file_ready
        const result = await transport.call('prepare_files', {}), ready = readWorkspaceRelocationFileActors(context.dataDir, context.id).file_ready
        if (!ready || !fields(result, ['dispatch', 'ready_sha256']) || !['dispatch', 'observe'].includes(result.dispatch)
          || previous && result.dispatch !== 'observe' || result.ready_sha256 !== sha256CanonicalJson(ready)) throw failure()
        transport.verify()
        return { dispatch: result.dispatch, ready }
      } catch { transport.close(); throw failure() }
    },
    async prepareRoot() {
      try {
        const previous = readWorkspaceRelocationRootPlan(context.dataDir, context.id)
        const result = await transport.call('prepare_root', {}), plan = readWorkspaceRelocationRootPlan(context.dataDir, context.id)
        if (!plan || !fields(result, ['dispatch', 'plan_sha256']) || !['dispatch', 'observe'].includes(result.dispatch)
          || previous && result.dispatch !== 'observe' || result.plan_sha256 !== sha256CanonicalJson(plan)) throw failure()
        transport.verify()
        return { dispatch: result.dispatch, plan_sha256: result.plan_sha256 }
      } catch { transport.close(); throw failure() }
    },
    async publishRoot() {
      try {
        const previous = readWorkspaceRelocationRootPublished(context.dataDir, context.id)
        const result = await transport.call('publish_root', {}), record = readWorkspaceRelocationRootPublished(context.dataDir, context.id)
        if (!record || !fields(result, ['dispatch', 'published_sha256']) || !['dispatch', 'observe'].includes(result.dispatch)
          || previous && result.dispatch !== 'observe' || result.published_sha256 !== sha256CanonicalJson(record)) throw failure()
        transport.verify()
        return result
      } catch { transport.close(); throw failure() }
    },
    async selectRoot() {
      try {
        const previous = readWorkspaceRelocationRootSelected(context.dataDir, context.id)
        const result = await transport.call('select_root', {}), record = readWorkspaceRelocationRootSelected(context.dataDir, context.id)
        if (!record || !fields(result, ['dispatch', 'selected_sha256']) || !['dispatch', 'observe'].includes(result.dispatch)
          || previous && result.dispatch !== 'observe' || result.selected_sha256 !== sha256CanonicalJson(record)) throw failure()
        transport.verify()
        return result
      } catch { transport.close(); throw failure() }
    },
    async verifySelectedRoot() {
      try {
        const result = await transport.call('verify_selected_root', {})
        const selected = readWorkspaceRelocationRootSelected(context.dataDir, context.id)
        const worker = readWorkspaceRelocationClosureCommit(context.dataDir, context.id), recovery = readWorkspaceRelocationRecoveryCommit(context.dataDir, context.id)
        if (!selected || !worker || !recovery || !fields(result, ['selected_sha256', 'worker_commit_sha256', 'recovery_commit_sha256'])
          || result.selected_sha256 !== sha256CanonicalJson(selected) || result.worker_commit_sha256 !== sha256CanonicalJson(worker)
          || result.recovery_commit_sha256 !== sha256CanonicalJson(recovery)) throw failure()
        transport.verify()
        return result
      } catch { transport.close(); throw failure() }
    },
    async recordHealth(report) {
      try {
        if (!fields(report, ['modules', 'root_proof']) || !Array.isArray(report.modules)) throw failure()
        const fixed = structuredClone(report)
        fixed.modules.sort((a, b) => a.module_id.localeCompare(b.module_id))
        const result = await transport.call('record_health', fixed)
        const record = readWorkspaceRelocationHealth(context.dataDir, context.id)
        if (!record || !fields(result, ['dispatch', 'health_sha256']) || !['dispatch', 'observe'].includes(result.dispatch)
          || result.health_sha256 !== sha256CanonicalJson(record)
          || sha256CanonicalJson(record.root_proof) !== sha256CanonicalJson(fixed.root_proof)
          || sha256CanonicalJson(record.modules) !== sha256CanonicalJson(fixed.modules)) throw failure()
        transport.verify()
        return result
      } catch (cause) { transport.close(); throw Object.assign(failure(), { cause }) }
    },
    close: transport.close,
  })
}
export function serveWorkspaceFileJournal(context) {
  const controller = new AbortController()
  let hostPreparation, filePreparation, rootPreparation, rootPublication, rootSelection, host, healthRecording, healthFingerprint
  const disconnectHost = child => { if (child?.connected) { try { child.disconnect() } catch {} } }
  const transport = serveWorkspaceJournal(context, 'file', {
    async prepare_completion(payload) {
      if (!fields(payload, [])) throw failure()
      return prepareWorkspaceRelocationCompletion({ dataDir: context.dataDir, id: context.id, signal: controller.signal })
    },
    async record_health(payload) {
      if (!fields(payload, ['modules', 'root_proof'])) throw failure()
      const fingerprint = sha256CanonicalJson(payload)
      if (healthFingerprint !== undefined && healthFingerprint !== fingerprint) throw failure()
      const previous = healthRecording
      if (!healthRecording) {
        healthFingerprint = fingerprint
        healthRecording = recordWorkspaceRelocationHealth({ dataDir: context.dataDir, id: context.id, report: payload, signal: controller.signal })
      }
      const result = await healthRecording
      return { ...result, dispatch: previous ? 'observe' : result.dispatch }
    },
    async verify_selected_root(payload) {
      if (!fields(payload, [])) throw failure()
      return verifyWorkspaceRelocationSelectedRoot({ dataDir: context.dataDir, id: context.id, signal: controller.signal })
    },
    async publish_root(payload) {
      if (!fields(payload, []) || !readWorkspaceRelocationRootPlan(context.dataDir, context.id)) throw failure()
      const previous = rootPublication
      if (!rootPublication) rootPublication = publishWorkspaceRelocationRoot({ dataDir: context.dataDir, id: context.id, signal: controller.signal })
      const result = await rootPublication
      return { dispatch: previous ? 'observe' : result.dispatch, published_sha256: result.published_sha256 }
    },
    async select_root(payload) {
      if (!fields(payload, []) || !readWorkspaceRelocationRootPublished(context.dataDir, context.id)) throw failure()
      const previous = rootSelection
      if (!rootSelection) rootSelection = selectWorkspaceRelocationRoot({ dataDir: context.dataDir, id: context.id, signal: controller.signal })
      const result = await rootSelection
      return { dispatch: previous ? 'observe' : result.dispatch, selected_sha256: result.selected_sha256 }
    },
    async prepare_root(payload) {
      if (!fields(payload, [])) throw failure()
      const args = { dataDir: context.dataDir, id: context.id, signal: controller.signal }
      await verifyWorkspaceRelocationClosureReadiness(args)
      if (!readWorkspaceRelocationRecoveryCommit(context.dataDir, context.id)) throw failure()
      const previous = rootPreparation
      if (!rootPreparation) rootPreparation = prepareWorkspaceRelocationRootPlan(args)
      const result = await rootPreparation
      return { dispatch: previous ? 'observe' : result.dispatch, plan_sha256: sha256CanonicalJson(result.plan) }
    },
    async prepare_files(payload) {
      if (!fields(payload, []) || !hostPreparation) throw failure()
      const previous = filePreparation
      if (!filePreparation) filePreparation = (async () => {
        const admitted = await hostPreparation
        if (hostAdmissionHash(readWorkspaceRelocationFileActors(context.dataDir, context.id)) !== admitted) throw failure()
        return prepareWorkspaceFilesWithHost(host, { dataDir: context.dataDir, id: context.id, signal: controller.signal })
      })()
      const result = await filePreparation
      return { dispatch: previous ? 'observe' : result.dispatch, ready_sha256: sha256CanonicalJson(result.ready) }
    },
    async prepare_stage(payload) {
      if (!fields(payload, []) || !hostPreparation) throw failure()
      const admitted = await hostPreparation
      if (hostAdmissionHash(readWorkspaceRelocationFileActors(context.dataDir, context.id)) !== admitted) throw failure()
      if (!host?.connected || host.exitCode !== null || host.signalCode !== null) throw failure()
      const result = prepareWorkspaceRelocationStaging({ dataDir: context.dataDir, id: context.id })
      return { dispatch: result.dispatch, staging_sha256: sha256CanonicalJson(result.staging) }
    },
    async prepare_host(payload) {
      if (!fields(payload, [])) throw failure()
      const previous = hostPreparation
      if (!hostPreparation) hostPreparation = (async () => {
        const result = await launchWorkspaceFileHost({ dataDir: context.dataDir, id: context.id })
        if (controller.signal.aborted) { disconnectHost(result.child); throw failure() }
        if (result.dispatch !== 'dispatch' || !result.child) throw failure()
        host = result.child
        return hostAdmissionHash(readWorkspaceRelocationFileActors(context.dataDir, context.id))
      })()
      const accepted = await hostPreparation, actors = readWorkspaceRelocationFileActors(context.dataDir, context.id)
      if (!host?.connected || host.exitCode !== null || host.signalCode !== null || hostAdmissionHash(actors) !== accepted
        || !native.sameProcess(actors.host.process, native.inspectProcess(host.pid))) throw failure()
      return { dispatch: previous ? 'observe' : 'dispatch', actors_sha256: sha256CanonicalJson(actors) }
    },
    async prepare(payload) {
      if (!fields(payload, [])) throw failure()
      const result = await prepareWorkspaceRelocationFilePlan({ dataDir: context.dataDir, id: context.id, signal: controller.signal })
      return { dispatch: result.dispatch, plan_sha256: sha256CanonicalJson(result.plan) }
    },
  })
  return Object.freeze({ close() { controller.abort(); transport.close(); disconnectHost(host) } })
}
