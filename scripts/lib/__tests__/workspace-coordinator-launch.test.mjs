import { workspaceMaintenancePending } from '../../../crabot-shared/dist/workspace-maintenance.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import native from '../process-identity.cjs'
import management from '../desktop-management.cjs'
import { acquireCliLock, acquireWorkspaceRelocationLock, cliLockToken, releaseCliLock } from '../cli-lock.mjs'
import { readWorkspaceRelocationExecutionExit, beginWorkspaceRelocationIntent, readWorkspaceRelocationCoordinator, readWorkspaceRelocationWorkers, readWorkspaceRelocationModules, readWorkspaceRelocationStops, readWorkspaceRelocationModuleStops } from '../workspace-relocation-intent.mjs'
import { launchWorkspaceRelocationCoordinator, workspaceCoordinatorDiagnostics } from '../workspace-coordinator-launch.mjs'
import { createWorkspaceWorkerJournal } from '../workspace-worker-journal.mjs'
import { createWorkspaceModuleJournal } from '../workspace-module-journal.mjs'
import { createWorkspaceFileJournal } from '../workspace-file-journal.mjs'
import { createWorkspaceJournalClient } from '../workspace-coordinator-journal.mjs'
import { readWorkspaceRelocationFilePlan, readWorkspaceRelocationFileActors, verifyWorkspaceRelocationClosureReadiness, readWorkspaceRelocationClosurePlan, readWorkspaceRelocationRecoveryPlan, readWorkspaceRelocationRecoveryCommit, readWorkspaceRelocationRootPlan } from '../workspace-relocation-intent.mjs'
import { createWorkspaceProcessJournal } from '../workspace-process-journal.mjs'
import { WorkspaceCatalog } from '../../../crabot-shared/dist/workspace-catalog.js'
import { sha256CanonicalJson } from '../../../crabot-shared/dist/canonical-json.js'

const crossVolumeParent = (() => {
  const candidates = process.platform === 'linux' ? ['/dev/shm'] : process.platform === 'win32' ? [
    process.env.RUNNER_TEMP,
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Temp'),
    process.env.GITHUB_ACTIONS === 'true' && process.cwd(),
  ] : []
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const directory = fs.realpathSync(candidate), stat = fs.statSync(directory)
      if (stat.isDirectory() && stat.dev !== fs.statSync(tmpdir()).dev) return directory
    } catch { /* An unavailable optional volume supplies no test evidence. */ }
  }
  return null
})()

async function fixture(t, { crossVolume = false, closureLedger = false, separateTargetAncestor = false, nestedTarget = false, historyIncarnation = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'coordinator-launch-')))
  if (crossVolume && !crossVolumeParent) {
    fs.rmdirSync(root)
    throw new Error('This cross-volume acceptance requires an actual writable directory on another device')
  }
  const targetRoot = crossVolume ? fs.mkdtempSync(path.join(crossVolumeParent, 'crabot-real-file-host-')) : root
  const targetParent = separateTargetAncestor ? path.join(targetRoot, 'target-parent') : targetRoot
  if (separateTargetAncestor) fs.mkdirSync(targetParent, { mode: 0o700 })
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), id = randomUUID()
  let closureWorker, ledgerFile, ledgerBytes, checkpointFile, checkpointBytes, externalWorkspace, nativeHistory
  if (closureLedger) {
    closureWorker = { worker_id: 'closure-worker', manager_key: 'fixture::closure', task_id: 'closure-task', workspace_id: 'default', incarnations: [] }
    ledgerFile = path.join(data, 'agent/worker-ledgers/fixture%3A%3Aclosure.json')
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true })
    ledgerBytes = JSON.stringify({ manager_key: closureWorker.manager_key, workers: [{ worker_id: closureWorker.worker_id, manager_key: closureWorker.manager_key, workspace_id: 'default',
      task: { id: closureWorker.task_id, title: 'keep original work', status: 'queued', created_at: '2026-10-20T00:00:00.000Z' },
      origin: { trigger_type: 'message', creator_friend_id: 'original-friend' }, report_to: { channel_id: 'fixture', session_id: 'closure' }, incarnations: [], updated_at: '2026-10-20T00:00:00.000Z' }] }, null, 2)
    fs.writeFileSync(ledgerFile, ledgerBytes, { mode: 0o600 })
    checkpointFile = path.join(data, 'agent/managers/fixture%3A%3Aclosure/running.json')
    checkpointBytes = JSON.stringify({ episodeId: 'original-recovery-episode', state: { key: closureWorker.manager_key, recent: [{ role: 'user', content: 'ORIGINAL_RECOVERY_PRIVATE_INPUT' }], foldedCount: 0 },
      envelopes: [], wakeIndex: -1, pending: [], hasEngineMessages: true, turns: [], responses: [], tools: [], pendingToolCallIds: ['unknown-original-operation'],
      adminChatClaims: [], transientMessageIds: [], spawnedWorkerIds: [closureWorker.worker_id], execution: { successfulSendMessageTargets: [], continuedWorkers: [],
        needsSpawnRecheck: false, spawnRecheckInjected: false, spawnRecheckOutcomeRecorded: false, postSendRecheckSequence: 0 } }) + '\n'
    fs.mkdirSync(path.dirname(checkpointFile), { recursive: true }); fs.writeFileSync(checkpointFile, checkpointBytes, { mode: 0o600 })
    fs.writeFileSync(path.join(path.dirname(checkpointFile), 'pending-admin-chat-wakes.jsonl'), JSON.stringify({ kind: 'admin_chat_wake', status: 'pending',
      request_id: 'original-admin-input', manager_key: closureWorker.manager_key, message_sha256: '1'.repeat(64), received_at: '2026-10-20T00:00:00.000Z',
      message: { content: { text: 'ORIGINAL_RECOVERY_PRIVATE_INPUT' } } }) + '\n', { mode: 0o600 })
  }
  const catalog = new WorkspaceCatalog({ dataRoot: data, files: native }); await catalog.initialize()
  if (closureLedger) {
    await catalog.createProject({ workspace_id: randomUUID(), name: 'managed', description: 'ROOT_PROJECT_PRIVATE_DESCRIPTION' })
    const external = path.join(root, 'outside-project'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'kept'), 'external project work')
    externalWorkspace = (await catalog.createProject({ workspace_id: randomUUID(), name: 'external', root: external })).workspace
  }
  const before = await catalog.snapshot(), marker = path.join(before.storage_root, 'original.txt')
  if (historyIncarnation) {
    const workspace = path.join(before.storage_root, 'default/tasks', closureWorker.worker_id)
    fs.mkdirSync(workspace, { recursive: true }); fs.writeFileSync(path.join(workspace, 'history.md'), 'original history artifact')
    const incarnation = { incarnation_id: 'history-mainline', impl: 'codex', seq: 1, state: 'exited', workspace,
      session_ref: '11111111-1111-4111-8111-111111111111', started_at: '2026-10-20T00:00:00.000Z', ended_at: '2026-10-20T00:01:00.000Z', ended_reason: 'completed' }
    const adapterData = path.join(data, 'agent/workers/codex'), privateDir = path.join(adapterData, closureWorker.worker_id)
    const metaFile = path.join(privateDir, 'meta-1.json'), source = path.join(workspace, '.codex/sessions/2026/10/20', 'rollout-2026-10-20T00-00-00-' + incarnation.session_ref + '.jsonl')
    const meta = JSON.stringify({ seq: 1, state: 'exited', ended_reason: 'completed', workspace_root: workspace, session_id: incarnation.session_ref, session_discovery: 'discovered' })
    const body = JSON.stringify({ type: 'response_item', timestamp: incarnation.started_at, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'original relocated native parent history' }] } }) + '\n'
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(metaFile, meta, { mode: 0o600 })
    fs.writeFileSync(path.join(privateDir, 'terminal-final-1.json'), JSON.stringify({ text: 'original retained native terminal', captured_at: incarnation.ended_at }), { mode: 0o600 })
    fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, body, { mode: 0o600 })
    nativeHistory = { adapterData, metaFile, meta, source, body, handle: { worker_id: closureWorker.worker_id, incarnation_id: incarnation.incarnation_id, seq: 1, impl: 'codex', session_ref: incarnation.session_ref } }
    closureWorker.incarnations = [{ incarnation_id: incarnation.incarnation_id, impl: incarnation.impl, seq: incarnation.seq, workspace, started_at: incarnation.started_at }]
    const ledger = JSON.parse(ledgerBytes); ledger.workers[0].incarnations = [incarnation]
    ledgerBytes = JSON.stringify(ledger, null, 2); fs.writeFileSync(ledgerFile, ledgerBytes, { mode: 0o600 })
  }
  fs.writeFileSync(marker, 'original work')
  const lock = await acquireCliLock(data, 'workspace-relocation')
  const intent = await beginWorkspaceRelocationIntent({ dataDir: data, id, target: path.join(targetParent, ...(nestedTarget ? ['missing-parent', 'nested', 'new'] : ['new'])), expectedRevision: before.revision, protectedRoots: [] })
  let coordinator
  const close = async () => {
    if (coordinator) {
      const child = coordinator.child
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, 'exit')
        if (child.connected) child.disconnect()
        await ended
      }
    }
  }
  t.after(async () => { if (coordinator && workspaceCoordinatorDiagnostics(coordinator.child)) t.diagnostic(workspaceCoordinatorDiagnostics(coordinator.child)); await close(); releaseCliLock(lock); fs.rmSync(root, { recursive: true, force: true }); if (crossVolume) fs.rmSync(targetRoot, { recursive: true, force: true }) })
  return { root, data, id, target: intent.target, lock, before, catalog, marker, close, closureWorker, ledgerFile, ledgerBytes, checkpointFile, checkpointBytes, externalWorkspace,
    nativeHistory,
    launch: async options => { try { coordinator = await launchWorkspaceRelocationCoordinator(options ?? { dataDir: data, id }); return coordinator } catch (error) { t.diagnostic(JSON.stringify({ stage: error.stage, code: error.code, cause_code: error.cause?.code, cause_stage: error.cause?.stage, cause_message: error.cause?.message, child_observation: error.child_observation, stderr: error.diagnostics })); throw error } } }
}

test('the actual fixed script owns the lock and serves the first journals before launch returns', { timeout: 20000 }, async t => {
  const f = await fixture(t), result = await f.launch(), { child, launch, ready } = result
  const worker = createWorkspaceWorkerJournal(child, { dataDir: f.data, id: f.id, launch })
  const modules = createWorkspaceModuleJournal(child, { dataDir: f.data, id: f.id, launch })
  const processes = createWorkspaceProcessJournal(child, { dataDir: f.data, id: f.id, launch })
  try {
    assert.equal(cliLockToken(f.lock), undefined)
    assert.ok(native.sameProcess(launch.process, native.inspectProcess(child.pid)))
    assert.equal(launch.parent.pid, process.pid)
    assert.deepEqual(readWorkspaceRelocationCoordinator(f.data, f.id), { launch, ready })
    await assert.rejects(acquireWorkspaceRelocationLock(f.data, f.id, 0), /another crabot CLI operation/)
    await worker.capture([]); await worker.captureProcesses([]); await modules.capture([])
    assert.equal(await processes.prepare(), 'dispatch'); assert.equal(await processes.prepare(), 'observe')
    await processes.observe([]); await processes.complete()
    assert.deepEqual(readWorkspaceRelocationWorkers(f.data, f.id).workers, [])
    assert.deepEqual(readWorkspaceRelocationModules(f.data, f.id).modules, [])
    assert.equal(readWorkspaceRelocationStops(f.data, f.id).attempt, null)
    assert.equal(readWorkspaceRelocationModuleStops(f.data, f.id).attempt, null)
    await worker.prepare([]); await worker.complete([])
    await modules.prepare([]); await modules.complete([])
    await processes.confirmExecutionExit()
    assert.equal(readWorkspaceRelocationExecutionExit(f.data, f.id).intent_id, f.id)
    assert.deepEqual(await f.catalog.snapshot(), f.before)
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'original work')
    assert.equal(fs.existsSync(f.target), false)
    const beforeHash = sha256CanonicalJson({ launch, ready })
    await f.close()
    assert.equal(sha256CanonicalJson(readWorkspaceRelocationCoordinator(f.data, f.id)), beforeHash)
    const lock = await acquireWorkspaceRelocationLock(f.data, f.id, 0); releaseCliLock(lock)
  } finally { worker.close(); modules.close(); processes.close() }
})

for (const mode of ['missing lock', 'wrong id', 'extra entry']) test('rejects before publishing a new launch: ' + mode, async t => {
  const f = await fixture(t)
  if (mode === 'missing lock') releaseCliLock(f.lock)
  const input = { dataDir: f.data, id: mode === 'wrong id' ? randomUUID() : f.id, ...(mode === 'extra entry' ? { entry: '/not-accepted' } : {}) }
  await assert.rejects(f.launch(input), { code: 'CRABOT_WORKSPACE_COORDINATOR' })
  assert.deepEqual(readWorkspaceRelocationCoordinator(f.data, f.id), { launch: null, ready: null })
  assert.equal(fs.readFileSync(f.marker, 'utf8'), 'original work')
})

test('does not inherit a parent Node loader and cannot create a second launch', { timeout: 20000 }, async t => {
  const f = await fixture(t), marker = path.join(f.root, 'loader-ran'), preload = path.join(f.root, 'parent-only.cjs')
  fs.writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'must not inherit')`)
  const previous = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = '--require ' + JSON.stringify(preload)
  let first
  try { first = await f.launch() }
  finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous }
  assert.equal(fs.existsSync(marker), false)
  const before = readWorkspaceRelocationCoordinator(f.data, f.id)
  await assert.rejects(launchWorkspaceRelocationCoordinator({ dataDir: f.data, id: f.id }), { code: 'CRABOT_WORKSPACE_COORDINATOR' })
  assert.deepEqual(readWorkspaceRelocationCoordinator(f.data, f.id), before)
  assert.equal(first.child.exitCode, null)
})

test('a concurrent launch cannot spawn another child before the first record is published', { timeout: 20000 }, async t => {
  const f = await fixture(t), before = new Set(native.listChildProcessIds(process.pid))
  const first = f.launch(), second = launchWorkspaceRelocationCoordinator({ dataDir: f.data, id: f.id })
  const settled = Promise.allSettled([first, second])
  try { assert.equal(native.listChildProcessIds(process.pid).filter(pid => !before.has(pid)).length, 1) }
  finally { await settled }
  const results = await settled
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected')
  assert.equal(results[1].reason.code, 'CRABOT_WORKSPACE_COORDINATOR')
})


for (const mode of ['Worker receipt missing', 'module receipt missing', 'live module behind claimed receipt', 'unknown module after actual exit', 'known module exited']) {
  test('unified execution exit requires complete independent evidence: ' + mode, { timeout: 20000 }, async t => {
    const f = await fixture(t), { child, launch } = await f.launch(), context = { dataDir: f.data, id: f.id, launch }
    const worker = createWorkspaceWorkerJournal(child, context), modules = createWorkspaceModuleJournal(child, context), processes = createWorkspaceProcessJournal(child, context)
    let actor, ended, scope = []
    t.after(async () => { if (actor) { if (actor.exitCode === null && actor.signalCode === null) actor.kill('SIGKILL'); await ended } })
    try {
      if (!mode.includes('receipt missing')) {
        actor = spawn(process.execPath, ['-e', 'process.send("ready");setTimeout(()=>{},20000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
        ended = once(actor, 'exit'); await once(actor, 'message')
        scope = [{ instance_id: 'finite-instance', module_id: 'finite-memory', module_port: 12345, runtime_id: 'finite-runtime', processes: [native.inspectProcess(actor.pid)] }]
      }
      await worker.capture([]); await worker.captureProcesses([]); await modules.capture(scope)
      await processes.prepare(); await processes.observe([]); await processes.complete()
      if (mode !== 'Worker receipt missing') { await worker.prepare([]); await worker.complete([]) }
      if (mode !== 'module receipt missing') {
        await modules.prepare(scope)
        if (actor) {
          await modules.observe('finite-memory', scope[0].processes)
          if (mode !== 'live module behind claimed receipt') { actor.kill('SIGKILL'); await ended }
        }
        await modules.complete(actor ? [{ module_id: 'finite-memory', runtime_id: 'finite-runtime', shutdown: 'submitted',
          status: mode === 'unknown module after actual exit' ? 'unknown' : 'known_scope_exited' }] : [])
      }
      const file = path.join(f.data, 'workspace-control/relocation-execution-exit.json')
      if (mode === 'known module exited') {
        await processes.confirmExecutionExit()
        const before = fs.readFileSync(file); await processes.confirmExecutionExit()
        assert.deepEqual(fs.readFileSync(file), before)
        assert.equal(readWorkspaceRelocationExecutionExit(f.data, f.id).intent_id, f.id)
      } else {
        await assert.rejects(processes.confirmExecutionExit(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
        assert.equal(fs.existsSync(file), false)
        if (mode === 'live module behind claimed receipt') assert.equal(native.isProcessExited(actor.pid), false)
      }
      assert.equal(fs.readFileSync(f.marker, 'utf8'), 'original work')
      assert.equal(fs.existsSync(f.target), false)
    } finally { worker.close(); modules.close(); processes.close() }
  })
}

for (const damage of ['hash', 'extra', 'hardlink', 'missing Native journal', 'missing coordinator']) {
  test('published execution evidence stays protected after damage: ' + damage, { timeout: 20000 }, async t => {
    const f = await fixture(t), { child, launch } = await f.launch(), context = { dataDir: f.data, id: f.id, launch }
    const worker = createWorkspaceWorkerJournal(child, context), modules = createWorkspaceModuleJournal(child, context), processes = createWorkspaceProcessJournal(child, context)
    try {
      await worker.capture([]); await worker.captureProcesses([]); await modules.capture([])
      await processes.prepare(); await processes.observe([]); await processes.complete()
      await worker.prepare([]); await worker.complete([]); await modules.prepare([]); await modules.complete([])
      await processes.confirmExecutionExit()
      const file = path.join(f.data, 'workspace-control/relocation-execution-exit.json')
      if (damage === 'hardlink') fs.linkSync(file, path.join(f.root, 'linked-exit'))
      else if (damage === 'missing Native journal') fs.unlinkSync(path.join(f.data, 'workspace-control/relocation-process-stop.jsonl'))
      else if (damage === 'missing coordinator') {
        fs.unlinkSync(path.join(f.data, 'workspace-control/relocation-coordinator.json'))
        fs.unlinkSync(path.join(f.data, 'workspace-control/relocation-coordinator-ready.json'))
      } else {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (damage === 'hash') value.process_stops_sha256 = '0'.repeat(64)
        if (damage === 'extra') value.permission = 'must reject'
        fs.writeFileSync(file, JSON.stringify(value))
      }
      const retained = fs.readFileSync(file)
      assert.throws(() => readWorkspaceRelocationExecutionExit(f.data, f.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
      await assert.rejects(processes.confirmExecutionExit(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
      assert.deepEqual(fs.readFileSync(file), retained)
      assert.equal(fs.readFileSync(f.marker, 'utf8'), 'original work')
      assert.equal(fs.existsSync(f.target), false)
    } finally { worker.close(); modules.close(); processes.close() }
  })
}


for (const scenario of ['normal', 'unexpected-path', 'lost-reply']) test('actual fixed coordinator file-plan channel: ' + scenario, { timeout: 25000 }, async t => {
  const f = await fixture(t), { child, launch } = await f.launch(), context = { dataDir: f.data, id: f.id, launch }
  const worker = createWorkspaceWorkerJournal(child, context), modules = createWorkspaceModuleJournal(child, context), processes = createWorkspaceProcessJournal(child, context)
  let files = createWorkspaceFileJournal(child, context)
  try {
    await worker.capture([]); await worker.captureProcesses([]); await modules.capture([])
    await processes.prepare(); await processes.observe([]); await processes.complete()
    await worker.prepare([]); await worker.complete([]); await modules.prepare([]); await modules.complete([])
    await processes.confirmExecutionExit()
    if (scenario === 'unexpected-path') {
      const invalid = createWorkspaceJournalClient(child, context, 'file')
      try { await assert.rejects(invalid.call('prepare', { target: path.join(f.root, 'untrusted') }), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }) } finally { invalid.close() }
      assert.equal(readWorkspaceRelocationFilePlan(f.data, f.id), null)
    }
    if (scenario === 'lost-reply') {
      const emit = child.emit; let dropped = false
      const mock = t.mock.method(child, 'emit', function(event, ...args) {
        if (event === 'message' && args[0]?.kind === 'workspace_file_journal_reply' && !dropped) { dropped = true; return emit.call(this, event, { ...args[0], ok: false }, ...args.slice(1)) }
        return emit.call(this, event, ...args)
      })
      try { await assert.rejects(files.prepare(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }); assert.equal(dropped, true) } finally { mock.mock.restore() }
      assert.ok(readWorkspaceRelocationFilePlan(f.data, f.id)); files.close(); files = createWorkspaceFileJournal(child, context)
    }
    const result = await files.prepare()
    assert.equal(result.dispatch, scenario === 'lost-reply' ? 'observe' : 'dispatch')
    assert.deepEqual(result.plan, readWorkspaceRelocationFilePlan(f.data, f.id))
    const first = fs.readFileSync(path.join(f.data, 'workspace-control/relocation-files.json'))
    assert.equal((await files.prepare()).dispatch, 'observe')
    assert.deepEqual(fs.readFileSync(path.join(f.data, 'workspace-control/relocation-files.json')), first)
    assert.equal(fs.existsSync(result.plan.staging_path), false); assert.equal(fs.existsSync(f.target), false)
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'original work'); assert.deepEqual(await f.catalog.snapshot(), f.before)
  } finally { worker.close(); modules.close(); processes.close(); files.close() }
})


for (const mode of ['confirmed', 'lost reply', 'unexpected payload', 'exited Host']) test('fixed file journal starts only one idle Host: ' + mode, { timeout: process.platform === 'win32' ? 60000 : 25000 }, async t => {
  const f = await fixture(t), { child, launch } = await f.launch(), context = { dataDir: f.data, id: f.id, launch }
  const workers = createWorkspaceWorkerJournal(child, context), modules = createWorkspaceModuleJournal(child, context), processes = createWorkspaceProcessJournal(child, context)
  let files = createWorkspaceFileJournal(child, context), host, hostExited = false, failed
  const confirmHostExit = async () => {
    const deadline = Date.now() + 2000; let last
    do {
      try { if (native.isProcessExited(host.pid) === true) { hostExited = true; return } } catch (error) { last = error }
      await new Promise(resolve => setTimeout(resolve, 10))
    } while (Date.now() < deadline)
    assert.fail('Host Kernel exit was not confirmed: ' + (last?.code ?? 'still active'))
  }
  try {
    await workers.capture([]); await workers.captureProcesses([]); await modules.capture([])
    await processes.prepare(); await processes.observe([]); await processes.complete()
    await workers.prepare([]); await workers.complete([]); await modules.prepare([]); await modules.complete([])
    await processes.confirmExecutionExit()
    await files.prepare()
    const describeChildren = () => native.listChildProcessIds(child.pid).map(pid => {
      try { return { process: native.inspectProcess(pid), argv: native.inspectProcessArguments(pid) } } catch (error) { return { pid, unavailable: error.code } }
    })
    const initialChildren = describeChildren(), initialPids = initialChildren.map(item => item.process?.pid)
    if (process.platform !== 'win32') assert.deepEqual(initialChildren, [])
    else {
      assert.ok(initialChildren.length <= 1, JSON.stringify(initialChildren))
      for (const item of initialChildren) {
        assert.equal(item.process?.parent, child.pid); assert.equal(item.process?.owner, launch.process.owner)
        assert.equal(fs.realpathSync.native(item.process.executable).toLowerCase(), fs.realpathSync.native(path.join(process.env.SystemRoot, 'System32/conhost.exe')).toLowerCase())
      }
    }
    if (mode === 'unexpected payload') {
      const invalid = createWorkspaceJournalClient(child, context, 'file')
      try { await assert.rejects(invalid.call('prepare_host', { entry: 'not-accepted' }), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }) } finally { invalid.close() }
      assert.equal(readWorkspaceRelocationFileActors(f.data, f.id).attempt, null)
    }
    if (mode === 'lost reply') {
      const emit = child.emit; let dropped = false
      const mock = t.mock.method(child, 'emit', function(event, ...args) {
        if (event === 'message' && args[0]?.kind === 'workspace_file_journal_reply' && args[0]?.operation === 'prepare_host' && !dropped) { dropped = true; return emit.call(this, event, { ...args[0], ok: false }, ...args.slice(1)) }
        return emit.call(this, event, ...args)
      })
      try { await assert.rejects(files.prepareHost(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }); assert.equal(dropped, true) } finally { mock.mock.restore() }
      assert.ok(readWorkspaceRelocationFileActors(f.data, f.id).permission)
      files.close(); files = createWorkspaceFileJournal(child, context)
    }
    const first = await files.prepareHost(); host = first.actors.host.process
    t.diagnostic('file Host channel: original Host admitted')
    assert.equal(first.dispatch, mode === 'lost reply' ? 'observe' : 'dispatch')
    assert.equal(host.parent, child.pid); assert.ok(native.sameProcess(host, native.inspectProcess(host.pid)))
    const bytes = fs.readFileSync(path.join(f.data, 'workspace-control/relocation-file-actors.jsonl'))
    const second = await files.prepareHost()
    assert.equal(second.dispatch, 'observe'); assert.deepEqual(second.actors, first.actors)
    assert.deepEqual(fs.readFileSync(path.join(f.data, 'workspace-control/relocation-file-actors.jsonl')), bytes)
    assert.deepEqual(native.listChildProcessIds(child.pid), [...initialPids, host.pid].sort((a, b) => a - b), JSON.stringify({ initial: initialChildren, current: describeChildren() }))
    for (const item of initialChildren) assert.ok(native.sameProcess(item.process, native.inspectProcess(item.process.pid)))
    const plan = readWorkspaceRelocationFilePlan(f.data, f.id)
    assert.equal(fs.existsSync(plan.staging_path), false); assert.equal(fs.existsSync(f.target), false)
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'original work'); assert.deepEqual(await f.catalog.snapshot(), f.before)
    if (mode === 'exited Host') {
      native.terminateKnownProcess(host)
      await confirmHostExit()
      t.diagnostic('file Host channel: original generation exited')
      await assert.rejects(files.prepareHost(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
      assert.deepEqual(native.listChildProcessIds(child.pid), initialPids)
      assert.deepEqual(fs.readFileSync(path.join(f.data, 'workspace-control/relocation-file-actors.jsonl')), bytes)
    }
    await f.close()
    if (!hostExited) await confirmHostExit()
    assert.deepEqual(readWorkspaceRelocationFileActors(f.data, f.id), first.actors)
  } catch (error) { failed = error; throw error }
  finally {
    workers.close(); modules.close(); processes.close(); files.close()
    if (host && !hostExited) try { native.terminateKnownProcess(host) } catch (error) {
      if (!failed) throw error
      t.diagnostic('Host cleanup also remained unverified: ' + error.code)
    }
  }
})

for (const mode of ['confirmed', 'lost acknowledgement', 'unexpected payload']) test('the actual file channel prepares one exclusive staging: ' + mode, { timeout: process.platform === 'win32' ? 60000 : 25000 }, async t => {
  const f = await fixture(t), { child, launch } = await f.launch(), context = { dataDir: f.data, id: f.id, launch }
  const workers = createWorkspaceWorkerJournal(child, context), modules = createWorkspaceModuleJournal(child, context), processes = createWorkspaceProcessJournal(child, context)
  let files = createWorkspaceFileJournal(child, context)
  try {
    await workers.capture([]); await workers.captureProcesses([]); await modules.capture([])
    await processes.prepare(); await processes.observe([]); await processes.complete()
    await workers.prepare([]); await workers.complete([]); await modules.prepare([]); await modules.complete([]); await processes.confirmExecutionExit()
    await files.prepare()
    if (mode === 'unexpected payload') {
      const invalid = createWorkspaceJournalClient(child, context, 'file')
      try { await assert.rejects(invalid.call('prepare_stage', { target: 'not-accepted' }), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }) } finally { invalid.close() }
      assert.equal(readWorkspaceRelocationFileActors(f.data, f.id).staging_attempt, null)
    }
    const host = await files.prepareHost()
    t.diagnostic('file staging channel: Host entered and original stop facts confirmed')
    if (mode === 'lost acknowledgement') {
      const emit = child.emit; let dropped = false
      const mock = t.mock.method(child, 'emit', function(event, ...args) {
        if (event === 'message' && args[0]?.kind === 'workspace_file_journal_reply' && args[0]?.operation === 'prepare_stage' && !dropped) {
          dropped = true; return emit.call(this, event, { ...args[0], ok: false }, ...args.slice(1))
        }
        return emit.call(this, event, ...args)
      })
      try { await assert.rejects(files.prepareStage(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }); assert.equal(dropped, true) } finally { mock.mock.restore() }
      assert.ok(readWorkspaceRelocationFileActors(f.data, f.id).staging)
      files.close(); files = createWorkspaceFileJournal(child, context)
    }
    const result = await files.prepareStage()
    assert.equal(result.dispatch, mode === 'lost acknowledgement' ? 'observe' : 'dispatch')
    assert.equal(result.staging.tree, null); assert.deepEqual(fs.readdirSync(result.staging.container.path), [])
    const before = fs.readFileSync(path.join(f.data, 'workspace-control/relocation-file-actors.jsonl'))
    assert.equal((await files.prepareStage()).dispatch, 'observe')
    assert.deepEqual(fs.readFileSync(path.join(f.data, 'workspace-control/relocation-file-actors.jsonl')), before)
    const observed = await files.prepareHost()
    assert.equal(observed.dispatch, 'observe'); assert.deepEqual(observed.actors.host, host.actors.host)
    assert.equal(fs.existsSync(f.target), false); assert.equal(fs.readFileSync(f.marker, 'utf8'), 'original work')
    assert.deepEqual(await f.catalog.snapshot(), f.before)
  } finally { workers.close(); modules.close(); processes.close(); files.close() }
})

for (const mode of ['confirmed', 'lost acknowledgement', 'changed source', 'copy', 'Root publish', 'Root lost acknowledgement', 'Root target changed', 'Root changed ancestor', 'Root nested target', 'Root nested target lost acknowledgement', 'Root nested parent changed']) test('the actual fixed Host prepares files once while the catalog stays unchanged: ' + mode, { timeout: process.platform === 'win32' ? 600000 : 120000, skip: mode === 'copy' && !crossVolumeParent && !(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true') }, async t => {
  const f = await fixture(t, { crossVolume: mode === 'copy', closureLedger: mode === 'confirmed' || mode === 'lost acknowledgement' || mode.startsWith('Root'), separateTargetAncestor: mode === 'Root changed ancestor', nestedTarget: mode.startsWith('Root nested'), historyIncarnation: mode === 'Root publish' }), { child, launch } = await f.launch(), context = { dataDir: f.data, id: f.id, launch }
  const workers = createWorkspaceWorkerJournal(child, context), modules = createWorkspaceModuleJournal(child, context), processes = createWorkspaceProcessJournal(child, context)
  let files = createWorkspaceFileJournal(child, context)
  try {
    const fixedWorkers = f.closureWorker ? [f.closureWorker] : []
    await workers.capture(fixedWorkers); await workers.captureProcesses([]); await modules.capture([])
    await processes.prepare(); await processes.observe([]); await processes.complete()
    await workers.prepare(fixedWorkers); await workers.complete(fixedWorkers.flatMap(worker => worker.incarnations.map(item => ({ worker_id: worker.worker_id, incarnation_id: item.incarnation_id, status: 'submitted' })))); await modules.prepare([]); await modules.complete([]); await processes.confirmExecutionExit()
    if (mode === 'confirmed') {
      const early = createWorkspaceWorkerJournal(child, context)
      try { await assert.rejects(early.verifyClosureReadiness(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }) } finally { early.close() }
      const earlyPrepare = createWorkspaceWorkerJournal(child, context)
      try { await assert.rejects(earlyPrepare.prepareClosure(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }) } finally { earlyPrepare.close() }
    }
    const plan = (await files.prepare()).plan, host = await files.prepareHost(); await files.prepareStage()
    if (mode === 'changed source') fs.writeFileSync(f.marker, 'new work must be preserved')
    if (mode === 'lost acknowledgement') {
      const emit = child.emit; let dropped = false
      const mock = t.mock.method(child, 'emit', function(event, ...args) {
        if (event === 'message' && args[0]?.kind === 'workspace_file_journal_reply' && args[0]?.operation === 'prepare_files' && !dropped) {
          dropped = true; return emit.call(this, event, { ...args[0], ok: false }, ...args.slice(1))
        }
        return emit.call(this, event, ...args)
      })
      try { await assert.rejects(files.prepareFiles(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }); assert.equal(dropped, true) } finally { mock.mock.restore() }
      assert.ok(readWorkspaceRelocationFileActors(f.data, f.id).file_ready)
      files.close(); files = createWorkspaceFileJournal(child, context)
    }
    if (mode === 'changed source') {
      await assert.rejects(files.prepareFiles(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
      assert.equal(readWorkspaceRelocationFileActors(f.data, f.id).file_ready, null)
      assert.equal(fs.readFileSync(f.marker, 'utf8'), 'new work must be preserved')
      assert.equal(fs.existsSync(path.join(plan.staging_path, 'tree')), false)
    } else {
      let result
      try { result = await files.prepareFiles() }
      catch (error) {
        if (mode === 'copy' && process.platform === 'win32') {
          const view = file => {
            const bytes = native.inspectFileMetadata(file).metadata, parts = []; let at = 0
            while (parts.length < 2) {
              const colon = bytes.indexOf(58, at), size = Number(bytes.subarray(at, colon).toString())
              parts.push(bytes.subarray(colon + 1, colon + 1 + size).toString('utf8')); at = colon + 1 + size
            }
            const stat = fs.statSync(file, { bigint: true })
            return { attributes: parts[0], acl: parts[1], mtime_ns: String(stat.mtimeNs) }
          }
          for (const relative of ['', 'default', 'default/tasks', 'projects', 'original.txt']) {
            try { t.diagnostic(JSON.stringify({ event: 'owned_cross_volume_metadata', relative,
              source: view(path.join(f.before.storage_root, relative)), target: view(path.join(plan.staging_path, 'tree', relative)) })) }
            catch { /* Keep the original failure if this finite diagnostic cannot be read. */ }
          }
        }
        throw error
      }
      assert.equal(result.dispatch, mode === 'lost acknowledgement' ? 'observe' : 'dispatch')
      assert.equal(result.ready.content_sha256, plan.source_content_sha256)
      assert.equal(fs.existsSync(f.before.storage_root), mode === 'copy')
      if (mode === 'copy') {
        assert.notEqual(fs.statSync(f.before.storage_root).dev, fs.statSync(plan.staging_path).dev)
        assert.equal(fs.readFileSync(f.marker, 'utf8'), 'original work')
        const actors = readWorkspaceRelocationFileActors(f.data, f.id)
        assert.deepEqual(actors.tools.tools.map(item => item.role), process.platform === 'win32' ? ['copy'] : ['pack', 'unpack'])
        assert.ok(actors.tool_permission); assert.ok(actors.tool_exit)
        assert.equal(result.ready.schema_version, 2)
        assert.equal(result.ready.metadata_fingerprint, plan.source_observation.metadata_fingerprint)
        assert.equal(result.ready.metadata_compatibility, process.platform === 'win32' ? 'windows-owner-inheritance-v1' : 'exact')
        if (process.platform === 'win32') {
          assert.ok(result.ready.legacy_owner_inheritance_files > 0)
          assert.notEqual(result.ready.target_metadata_fingerprint, result.ready.metadata_fingerprint)
        } else assert.equal(result.ready.target_metadata_fingerprint, result.ready.metadata_fingerprint)
      }
      assert.equal(fs.readFileSync(path.join(plan.staging_path, 'tree/original.txt'), 'utf8'), 'original work')
      assert.equal(native.isProcessExited(host.actors.host.process.pid), true)
      const control = path.join(f.data, 'workspace-control')
      const snapshotControl = () => fs.readdirSync(control).sort().map(name => {
        const file = path.join(control, name), stat = fs.lstatSync(file, { bigint: true })
        return [name, stat.isFile() ? fs.readFileSync(file) : [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(':')]
      })
      const unchanged = snapshotControl()
      const proof = await workers.verifyClosureReadiness()
      assert.equal(proof.verified, true); assert.equal(proof.intent_id, f.id)
      assert.deepEqual(await workers.verifyClosureReadiness(), proof)
      assert.deepEqual(snapshotControl(), unchanged)
      if (mode === 'confirmed') {
        await assert.rejects(verifyWorkspaceRelocationClosureReadiness({ dataDir: f.data, id: f.id }), { code: 'WORKSPACE_RELOCATION_INVALID' })
        const injected = createWorkspaceJournalClient(child, context, 'worker')
        try { await assert.rejects(injected.call('verify_closure_readiness', { directory: f.root }), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }) } finally { injected.close() }
        const refused = async () => {
          const observer = createWorkspaceWorkerJournal(child, context)
          try { await assert.rejects(observer.verifyClosureReadiness(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }) } finally { observer.close() }
        }
        const catalogFile = path.join(control, 'catalog.json'), originalCatalog = fs.readFileSync(catalogFile)
        const changed = JSON.parse(originalCatalog); changed.revision++
        try { fs.writeFileSync(catalogFile, JSON.stringify(changed)); await refused() } finally { fs.writeFileSync(catalogFile, originalCatalog) }
        const tree = path.join(plan.staging_path, 'tree'), saved = path.join(path.dirname(plan.staging_path), 'saved-tree-' + f.id)
        fs.renameSync(tree, saved)
        try { fs.mkdirSync(tree, { mode: 0o700 }); await refused() } finally { fs.rmdirSync(tree); fs.renameSync(saved, tree) }
        fs.mkdirSync(f.before.storage_root)
        try { await refused() } finally { fs.rmdirSync(f.before.storage_root) }
        assert.deepEqual(await workers.verifyClosureReadiness(), proof)
        assert.deepEqual(snapshotControl(), unchanged)
      }
      if (f.closureWorker) {
        const earlyRoot = createWorkspaceFileJournal(child, context)
        try { await assert.rejects(earlyRoot.prepareRoot(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }) } finally { earlyRoot.close() }
        assert.equal(readWorkspaceRelocationRootPlan(f.data, f.id), null)
        let closer = createWorkspaceWorkerJournal(child, context)
        try {
          if (mode === 'lost acknowledgement') {
            const emit = child.emit; let dropped = false
            const mock = t.mock.method(child, 'emit', function(event, ...args) {
              if (event === 'message' && args[0]?.kind === 'workspace_worker_journal_reply' && args[0]?.operation === 'prepare_closure' && !dropped) {
                dropped = true; return emit.call(this, event, { ...args[0], ok: false }, ...args.slice(1))
              }
              return emit.call(this, event, ...args)
            })
            try { await assert.rejects(closer.prepareClosure(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }); assert.equal(dropped, true) } finally { mock.mock.restore() }
            closer.close(); closer = createWorkspaceWorkerJournal(child, context)
          }
          const preparationStarted = Date.now(), prepared = await closer.prepareClosure()
          t.diagnostic('Agent fixed closure preparation confirmed in ' + (Date.now() - preparationStarted) + 'ms')
          assert.equal(prepared.dispatch, mode === 'lost acknowledgement' ? 'observe' : 'dispatch')
          assert.equal(prepared.plan.ledgers[0].closed_worker_ids[0], f.closureWorker.worker_id)
          assert.notEqual(prepared.plan.ledgers[0].before_sha256, prepared.plan.ledgers[0].after_sha256)
          const planBytes = fs.readFileSync(path.join(control, 'relocation-worker-closure.json'))
          assert.equal((await closer.prepareClosure()).dispatch, 'observe')
          assert.deepEqual(fs.readFileSync(path.join(control, 'relocation-worker-closure.json')), planBytes)
          assert.equal(fs.readFileSync(f.ledgerFile, 'utf8'), f.ledgerBytes)
          const original = fs.lstatSync(f.ledgerFile, { bigint: true })
          assert.equal([original.dev, original.ino, original.size, original.mtimeNs, original.ctimeNs, original.mode, original.uid, original.gid, original.nlink].join(':'), prepared.plan.ledgers[0].before_version)
          assert.equal(planBytes.includes(Buffer.from('original-friend')), false)
          const planFile = path.join(control, 'relocation-worker-closure.json')
          for (const change of ['foreign Worker', 'missing ledger', 'path', 'unchanged hash', 'binding']) {
            const invalid = JSON.parse(planBytes)
            if (change === 'foreign Worker') invalid.ledgers[0].closed_worker_ids = ['foreign-worker']
            if (change === 'missing ledger') invalid.ledgers = []
            if (change === 'path') invalid.ledgers[0].name = '../outside.json'
            if (change === 'unchanged hash') invalid.ledgers[0].after_sha256 = invalid.ledgers[0].before_sha256
            if (change === 'binding') invalid.bindings.file_ready_sha256 = '0'.repeat(64)
            try {
              fs.writeFileSync(planFile, JSON.stringify(invalid))
              assert.throws(() => readWorkspaceRelocationClosurePlan(f.data, f.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
            } finally { fs.writeFileSync(planFile, planBytes) }
          }
          assert.equal((await closer.prepareClosure()).dispatch, 'observe')
          assert.equal(fs.readFileSync(f.ledgerFile, 'utf8'), f.ledgerBytes)
          const agent = await import('../../../crabot-agent/dist/core/workspace-relocation-closure.js')
          await assert.rejects(agent.commitWorkspaceRelocationClosure({ dataDir: f.data, id: f.id }), { code: 'CRABOT_WORKSPACE_CLOSURE_COMMIT' })
          assert.equal(fs.readFileSync(f.ledgerFile, 'utf8'), f.ledgerBytes)
          const invalidCommit = createWorkspaceJournalClient(child, context, 'worker')
          try { await assert.rejects(invalidCommit.call('commit_closure', { directory: f.root }), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }) } finally { invalidCommit.close() }
          if (mode === 'lost acknowledgement') {
            const emit = child.emit; let dropped = false
            const mock = t.mock.method(child, 'emit', function(event, ...args) {
              if (event === 'message' && args[0]?.kind === 'workspace_worker_journal_reply' && args[0]?.operation === 'commit_closure' && !dropped) {
                dropped = true; return emit.call(this, event, { ...args[0], ok: false }, ...args.slice(1))
              }
              return emit.call(this, event, ...args)
            })
            try { await assert.rejects(closer.commitClosure(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }); assert.equal(dropped, true) } finally { mock.mock.restore() }
            closer.close(); closer = createWorkspaceWorkerJournal(child, context)
          }
          const commitStarted = Date.now(), committed = await closer.commitClosure()
          t.diagnostic('Agent fixed closure commit confirmed in ' + (Date.now() - commitStarted) + 'ms')
          assert.equal(committed.dispatch, mode === 'lost acknowledgement' ? 'observe' : 'dispatch')
          const closedBytes = fs.readFileSync(f.ledgerFile), closedStat = fs.lstatSync(f.ledgerFile, { bigint: true })
          const closed = JSON.parse(closedBytes).workers[0], old = JSON.parse(f.ledgerBytes).workers[0]
          assert.equal(closed.task.status, 'closed'); assert.equal(closed.task.closed.by, 'migration')
          assert.equal(closed.task.closed.note, 'workspace relocation ' + f.id)
          assert.deepEqual(closed.origin, old.origin); assert.deepEqual(closed.report_to, old.report_to); assert.deepEqual(closed.incarnations, old.incarnations)
          assert.equal((await closer.commitClosure()).dispatch, 'observe')
          assert.deepEqual(fs.readFileSync(f.ledgerFile), closedBytes)
          const observed = fs.lstatSync(f.ledgerFile, { bigint: true })
          for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink']) assert.equal(observed[field], closedStat[field])
          const recoveryAgent = await import('../../../crabot-agent/dist/core/workspace-relocation-recovery.js')
          await assert.rejects(recoveryAgent.prepareWorkspaceRelocationRecovery({ dataDir: f.data, id: f.id }), { code: 'CRABOT_WORKSPACE_RECOVERY_PLAN' })
          const invalidRecovery = createWorkspaceJournalClient(child, context, 'worker')
          try { await assert.rejects(invalidRecovery.call('prepare_recovery', { directory: f.root }), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }) } finally { invalidRecovery.close() }
          if (mode === 'lost acknowledgement') {
            const emit = child.emit; let dropped = false
            const mock = t.mock.method(child, 'emit', function(event, ...args) {
              if (event === 'message' && args[0]?.kind === 'workspace_worker_journal_reply' && args[0]?.operation === 'prepare_recovery' && !dropped) {
                dropped = true; return emit.call(this, event, { ...args[0], ok: false }, ...args.slice(1))
              }
              return emit.call(this, event, ...args)
            })
            try { await assert.rejects(closer.prepareRecovery(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }); assert.equal(dropped, true) } finally { mock.mock.restore() }
            closer.close(); closer = createWorkspaceWorkerJournal(child, context)
          }
          const recoveryStarted = Date.now(), recovery = await closer.prepareRecovery()
          t.diagnostic('Agent fixed recovery plan confirmed in ' + (Date.now() - recoveryStarted) + 'ms')
          assert.equal(recovery.dispatch, mode === 'lost acknowledgement' ? 'observe' : 'dispatch')
          const recoveryFile = path.join(control, 'relocation-manager-closure.json'), recoveryBytes = fs.readFileSync(recoveryFile)
          const recoveryPlan = JSON.parse(recoveryBytes)
          assert.equal(recovery.plan_sha256, sha256CanonicalJson(recoveryPlan))
          assert.equal(recoveryPlan.intent_id, f.id)
          assert.equal(recoveryPlan.worker_closure_sha256, sha256CanonicalJson(committed.complete))
          assert.equal(recoveryPlan.snapshot.checkpoints[0].episode_id, 'original-recovery-episode')
          assert.deepEqual(recoveryPlan.snapshot.records, [{ kind: 'admin_chat', manager_key: f.closureWorker.manager_key, request_id: 'original-admin-input', message_sha256: '1'.repeat(64) }])
          assert.equal(recoveryBytes.includes(Buffer.from('ORIGINAL_RECOVERY_PRIVATE_INPUT')), false)
          assert.equal(recoveryBytes.includes(Buffer.from('unknown-original-operation')), false)
          assert.equal(fs.readFileSync(f.checkpointFile, 'utf8'), f.checkpointBytes)
          assert.equal(fs.existsSync(path.join(f.data, 'agent/workspace-relocation-retirements')), false)
          for (const change of ['binding', 'scope hash', 'path', 'body', 'checkpoint digest']) {
            const invalid = structuredClone(recoveryPlan)
            if (change === 'binding') invalid.worker_closure_sha256 = '0'.repeat(64)
            if (change === 'scope hash') invalid.snapshot_sha256 = '0'.repeat(64)
            if (change === 'path') invalid.snapshot.directories[0].relative = '..'
            if (change === 'body') invalid.snapshot.records[0].permissions = { shell: true }
            if (change === 'checkpoint digest') invalid.snapshot.checkpoints[0].before_sha256 = '0'.repeat(64)
            if (!['scope hash', 'binding'].includes(change)) invalid.snapshot_sha256 = sha256CanonicalJson(invalid.snapshot)
            try {
              fs.writeFileSync(recoveryFile, JSON.stringify(invalid))
              assert.throws(() => readWorkspaceRelocationRecoveryPlan(f.data, f.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
            } finally { fs.writeFileSync(recoveryFile, recoveryBytes) }
          }
          assert.equal((await closer.prepareRecovery()).dispatch, 'observe')
          assert.deepEqual(fs.readFileSync(recoveryFile), recoveryBytes)
          const recoveryCompleteFile = path.join(control, 'relocation-manager-complete.json')
          for (const invalid of [null, false, {}, { schema_version: 1, intent_id: f.id }]) {
            try {
              fs.writeFileSync(recoveryCompleteFile, JSON.stringify(invalid), { mode: 0o600 })
              assert.throws(() => readWorkspaceRelocationRecoveryCommit(f.data, f.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
              await assert.rejects(recoveryAgent.commitWorkspaceRelocationRecovery({ dataDir: f.data, id: f.id }), { code: 'CRABOT_WORKSPACE_RECOVERY_COMMIT' })
            } finally { fs.unlinkSync(recoveryCompleteFile) }
          }
          assert.equal(fs.readFileSync(f.checkpointFile, 'utf8'), f.checkpointBytes)
          assert.equal(fs.existsSync(path.join(f.data, 'agent/workspace-relocation-retirements')), false)
          const invalidRecoveryCommit = createWorkspaceJournalClient(child, context, 'worker')
          try { await assert.rejects(invalidRecoveryCommit.call('commit_recovery', { directory: f.root }), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }) } finally { invalidRecoveryCommit.close() }
          if (mode === 'lost acknowledgement') {
            const emit = child.emit; let dropped = false
            const mock = t.mock.method(child, 'emit', function(event, ...args) {
              if (event === 'message' && args[0]?.kind === 'workspace_worker_journal_reply' && args[0]?.operation === 'commit_recovery' && !dropped) {
                dropped = true; return emit.call(this, event, { ...args[0], ok: false }, ...args.slice(1))
              }
              return emit.call(this, event, ...args)
            })
            try { await assert.rejects(closer.commitRecovery(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }); assert.equal(dropped, true) } finally { mock.mock.restore() }
            closer.close(); closer = createWorkspaceWorkerJournal(child, context)
          }
          const recoveryCommit = await closer.commitRecovery(), completeBytes = fs.readFileSync(recoveryCompleteFile)
          assert.equal(recoveryCommit.dispatch, mode === 'lost acknowledgement' ? 'observe' : 'dispatch')
          const complete = readWorkspaceRelocationRecoveryCommit(f.data, f.id)
          assert.equal(recoveryCommit.commit_sha256, sha256CanonicalJson(complete))
          assert.equal(complete.plan_sha256, recovery.plan_sha256)
          assert.equal(complete.checkpoints.length, 1)
          const archive = path.join(path.dirname(f.checkpointFile), 'workspace-relocation-history', f.id)
          assert.equal(fs.readFileSync(path.join(archive, 'checkpoint.json'), 'utf8'), f.checkpointBytes)
          assert.equal(fs.existsSync(f.checkpointFile), false)
          const retirementFile = path.join(f.data, 'agent/workspace-relocation-retirements', f.id + '.json'), retirementBytes = fs.readFileSync(retirementFile)
          const retirement = JSON.parse(retirementBytes)
          assert.deepEqual(retirement.records, recoveryPlan.snapshot.records)
          assert.equal(complete.retirement_sha256, sha256CanonicalJson(retirement))
          assert.equal((await closer.commitRecovery()).dispatch, 'observe')
          assert.deepEqual(fs.readFileSync(recoveryCompleteFile), completeBytes)
          assert.deepEqual(fs.readFileSync(retirementFile), retirementBytes)
          const closedEvidence = await closer.inspectClosures()
          assert.deepEqual(await closer.inspectClosures(), closedEvidence)
          assert.equal(closedEvidence.worker_commit_sha256, sha256CanonicalJson(committed.complete))
          assert.equal(closedEvidence.recovery_commit_sha256, recoveryCommit.commit_sha256)
          assert.deepEqual(fs.readFileSync(recoveryCompleteFile), completeBytes)
          assert.deepEqual(fs.readFileSync(retirementFile), retirementBytes)
          assert.deepEqual(fs.readFileSync(f.ledgerFile), closedBytes)
          const rootRecords = await import('../workspace-relocation-intent.mjs')
          const rootPrepareLost = mode === 'lost acknowledgement' || mode === 'Root nested target lost acknowledgement'
          await assert.rejects(rootRecords.prepareWorkspaceRelocationRootPlan({ dataDir: f.data, id: f.id }))
          assert.equal(readWorkspaceRelocationRootPlan(f.data, f.id), null)
          const invalidRoot = createWorkspaceJournalClient(child, context, 'file')
          try { await assert.rejects(invalidRoot.call('prepare_root', { directory: f.root }), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }) } finally { invalidRoot.close() }
          if (rootPrepareLost) {
            const emit = child.emit; let dropped = false
            const mock = t.mock.method(child, 'emit', function(event, ...args) {
              if (event === 'message' && args[0]?.kind === 'workspace_file_journal_reply' && args[0]?.operation === 'prepare_root' && !dropped) {
                dropped = true; return emit.call(this, event, { ...args[0], ok: false }, ...args.slice(1))
              }
              return emit.call(this, event, ...args)
            })
            try { await assert.rejects(files.prepareRoot(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }); assert.equal(dropped, true) } finally { mock.mock.restore() }
            files.close(); files = createWorkspaceFileJournal(child, context)
          }
          if (mode === 'Root changed ancestor') {
            const anchor = path.dirname(f.target), saved = anchor + '-original-' + f.id
            assert.equal(fs.existsSync(saved), false)
            fs.renameSync(anchor, saved); fs.mkdirSync(anchor, { mode: 0o700 })
            for (const name of fs.readdirSync(saved)) fs.renameSync(path.join(saved, name), path.join(anchor, name))
            try {
              await assert.rejects(files.prepareRoot(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
              assert.equal(readWorkspaceRelocationRootPlan(f.data, f.id), null)
              assert.equal(fs.existsSync(path.join(anchor, 'new')), false)
              assert.deepEqual(await f.catalog.snapshot(), f.before)
              assert.deepEqual(fs.readFileSync(f.ledgerFile), closedBytes)
            } finally {
              for (const name of fs.readdirSync(anchor)) fs.renameSync(path.join(anchor, name), path.join(saved, name))
              fs.rmdirSync(anchor); fs.renameSync(saved, anchor)
            }
            files.close(); files = createWorkspaceFileJournal(child, context)
            await assert.rejects(files.prepareRoot(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
            assert.equal(readWorkspaceRelocationRootPlan(f.data, f.id), null)
            assert.equal(workspaceMaintenancePending(f.data), true)
            return
          }
          const rootStarted = Date.now()
          const rootPrepared = await files.prepareRoot(), rootPlan = readWorkspaceRelocationRootPlan(f.data, f.id)
          t.diagnostic('Fixed Root preparation confirmed in ' + (Date.now() - rootStarted) + 'ms')
          assert.equal(rootPrepared.dispatch, rootPrepareLost ? 'observe' : 'dispatch')
          assert.equal(rootPrepared.plan_sha256, sha256CanonicalJson(rootPlan))
          assert.equal(rootPlan.worker_commit_sha256, closedEvidence.worker_commit_sha256)
          assert.equal(rootPlan.recovery_commit_sha256, closedEvidence.recovery_commit_sha256)
          assert.equal(rootPlan.publication.target, f.target)
          assert.equal(rootPlan.publication.target_parent.path, path.dirname(f.target))
          assert.ok(fs.statSync(path.dirname(f.target)).isDirectory())
          assert.equal(rootPlan.publication.tree.ino, result.ready.tree.ino)
          assert.equal(rootPlan.publication.empty_target, null)
          const expectedMappings = f.before.workspaces.filter(item => item.workspace_id !== f.externalWorkspace.workspace_id).map(item => ({ workspace_id: item.workspace_id,
            before_root: item.root, after_root: path.join(f.target, path.relative(f.before.storage_root, item.root)) })).sort((a, b) => a.workspace_id < b.workspace_id ? -1 : 1)
          assert.deepEqual(rootPlan.catalog_mappings, expectedMappings)
          assert.equal(fs.readFileSync(path.join(f.root, 'outside-project/kept'), 'utf8'), 'external project work')
          const rootFile = path.join(control, 'relocation-root-plan.json'), rootBytes = fs.readFileSync(rootFile)
          assert.equal((await files.prepareRoot()).dispatch, 'observe'); assert.deepEqual(fs.readFileSync(rootFile), rootBytes)
          assert.equal(fs.existsSync(f.target), false); assert.deepEqual(await f.catalog.snapshot(), f.before)
          assert.equal(rootBytes.includes(Buffer.from('ORIGINAL_RECOVERY_PRIVATE_INPUT')), false)
          assert.equal(rootBytes.includes(Buffer.from('keep original work')), false)
          assert.equal(rootBytes.includes(Buffer.from('ROOT_PROJECT_PRIVATE_DESCRIPTION')), false)
          for (const change of ['binding', 'tree identity', 'mapping target', 'missing default', 'extra field']) {
            const invalid = structuredClone(rootPlan)
            if (change === 'binding') invalid.worker_commit_sha256 = '0'.repeat(64)
            if (change === 'tree identity') invalid.publication.tree.ino = '999999999999999'
            if (change === 'mapping target') invalid.catalog_mappings[0].after_root = path.join(f.root, 'unselected')
            if (change === 'missing default') invalid.catalog_mappings = invalid.catalog_mappings.filter(row => row.workspace_id !== 'default')
            if (change === 'extra field') invalid.permissions = { all: true }
            try { fs.writeFileSync(rootFile, JSON.stringify(invalid)); assert.throws(() => readWorkspaceRelocationRootPlan(f.data, f.id)) }
            finally { fs.writeFileSync(rootFile, rootBytes) }
          }
          assert.equal((await files.prepareRoot()).dispatch, 'observe')
          if (mode.startsWith('Root nested')) {
            const parents = rootRecords.readWorkspaceRelocationRootParentsPlan(f.data, f.id)
            const completeParents = rootRecords.readWorkspaceRelocationRootParentsComplete(f.data, f.id)
            assert.equal(rootPlan.parents_commit_sha256, sha256CanonicalJson(completeParents))
            assert.equal(completeParents.plan_sha256, sha256CanonicalJson(parents))
            assert.equal(parents.publication.target, path.join(plan.staging_parent.path, 'missing-parent'))
            assert.deepEqual(parents.chain.map(item => item.relative), ['', 'nested'])
            assert.equal(parents.worker_commit_sha256, closedEvidence.worker_commit_sha256)
            const parentFile = path.join(control, 'relocation-root-parents.json'), completeFile = path.join(control, 'relocation-root-parents-complete.json')
            const parentBytes = fs.readFileSync(parentFile), completeParentBytes = fs.readFileSync(completeFile)
            assert.equal(parentBytes.includes(Buffer.from('ORIGINAL_RECOVERY_PRIVATE_INPUT')), false)
            assert.equal(parentBytes.includes(Buffer.from('ROOT_PROJECT_PRIVATE_DESCRIPTION')), false)
            for (const change of ['chain identity', 'extra body']) {
              const invalid = structuredClone(parents)
              if (change === 'chain identity') invalid.chain[1].ino = '99999999999999'
              else invalid.message = 'untrusted body'
              try { fs.writeFileSync(parentFile, JSON.stringify(invalid)); assert.throws(() => rootRecords.readWorkspaceRelocationRootPlan(f.data, f.id)) }
              finally { fs.writeFileSync(parentFile, parentBytes) }
            }
            const kept = path.join(f.root, 'kept-parent-complete')
            fs.renameSync(completeFile, kept)
            try { assert.throws(() => rootRecords.readWorkspaceRelocationRootPlan(f.data, f.id)) }
            finally { fs.renameSync(kept, completeFile) }
            assert.equal((await files.prepareRoot()).dispatch, 'observe')
            assert.deepEqual(fs.readFileSync(parentFile), parentBytes); assert.deepEqual(fs.readFileSync(completeFile), completeParentBytes)
          } else assert.equal(rootPlan.parents_commit_sha256, null)
          if (mode.startsWith('Root')) {
            await assert.rejects(rootRecords.publishWorkspaceRelocationRoot({ dataDir: f.data, id: f.id }))
            await assert.rejects(rootRecords.selectWorkspaceRelocationRoot({ dataDir: f.data, id: f.id }))
            for (const operation of ['publish_root', 'select_root']) {
              const invalid = createWorkspaceJournalClient(child, context, 'file')
              try { await assert.rejects(invalid.call(operation, { directory: f.root }), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }) } finally { invalid.close() }
            }
            const earlySelection = createWorkspaceFileJournal(child, context)
            try { await assert.rejects(earlySelection.selectRoot(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }) } finally { earlySelection.close() }
            const rootLost = mode === 'Root lost acknowledgement' || mode === 'Root nested target lost acknowledgement'
            const rootResult = async operation => {
              if (!rootLost) return files[operation]()
              const wireOperation = operation === 'publishRoot' ? 'publish_root' : 'select_root'
              const emit = child.emit; let dropped = false
              const mock = t.mock.method(child, 'emit', function(event, ...args) {
                if (event === 'message' && args[0]?.kind === 'workspace_file_journal_reply' && args[0]?.operation === wireOperation && !dropped) {
                  dropped = true; return emit.call(this, event, { ...args[0], ok: false }, ...args.slice(1))
                }
                return emit.call(this, event, ...args)
              })
              try { await assert.rejects(files[operation](), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }); assert.equal(dropped, true) } finally { mock.mock.restore() }
              files.close(); files = createWorkspaceFileJournal(child, context)
              return files[operation]()
            }
            if (mode === 'Root nested parent changed') {
              const foreign = path.join(path.dirname(f.target), 'later-user-file')
              fs.writeFileSync(foreign, 'preserve new user content')
              await assert.rejects(files.publishRoot(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
              assert.equal(rootRecords.readWorkspaceRelocationRootPublished(f.data, f.id), null)
              assert.equal(fs.existsSync(f.target), false); assert.deepEqual(await f.catalog.snapshot(), f.before)
              assert.equal(fs.readFileSync(foreign, 'utf8'), 'preserve new user content')
              assert.equal(fs.readFileSync(path.join(plan.staging_path, 'tree/original.txt'), 'utf8'), 'original work')
              assert.deepEqual(fs.readFileSync(f.ledgerFile), closedBytes); assert.equal(workspaceMaintenancePending(f.data), true)
              return
            }
            const publicationStarted = Date.now()
            const published = await rootResult('publishRoot'), publishedFile = path.join(control, 'relocation-root-published.json')
            t.diagnostic('Fixed Root publication confirmed in ' + (Date.now() - publicationStarted) + 'ms')
            const publishedBytes = fs.readFileSync(publishedFile), publishedRecord = rootRecords.readWorkspaceRelocationRootPublished(f.data, f.id)
            assert.equal(published.dispatch, rootLost ? 'observe' : 'dispatch')
            assert.equal(published.published_sha256, sha256CanonicalJson(publishedRecord))
            assert.equal(publishedRecord.plan_sha256, rootPrepared.plan_sha256)
            assert.equal(publishedRecord.content_sha256, result.ready.content_sha256)
            assert.equal(fs.readFileSync(path.join(f.target, 'original.txt'), 'utf8'), 'original work')
            assert.equal(fs.existsSync(rootPlan.publication.tree.path), false)
            assert.deepEqual(await f.catalog.snapshot(), f.before)
            assert.equal((await files.publishRoot()).dispatch, 'observe'); assert.deepEqual(fs.readFileSync(publishedFile), publishedBytes)
            assert.equal(workspaceMaintenancePending(f.data), true)
            const selectedFile = path.join(control, 'relocation-root-selected.json')
            if (mode === 'Root target changed') {
              fs.appendFileSync(path.join(f.target, 'original.txt'), ' changed work must remain')
              await assert.rejects(files.selectRoot(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
              assert.equal(fs.existsSync(selectedFile), false); assert.deepEqual(await f.catalog.snapshot(), f.before)
              assert.equal(fs.readFileSync(path.join(f.target, 'original.txt'), 'utf8'), 'original work changed work must remain')
              assert.deepEqual(fs.readFileSync(publishedFile), publishedBytes)
            } else {
              const selectionStarted = Date.now()
              const selected = await rootResult('selectRoot'), selectedBytes = fs.readFileSync(selectedFile)
              t.diagnostic('Fixed Root selection confirmed in ' + (Date.now() - selectionStarted) + 'ms')
              const after = await f.catalog.snapshot()
              assert.equal(selected.dispatch, rootLost ? 'observe' : 'dispatch')
              assert.equal(selected.selected_sha256, sha256CanonicalJson(rootRecords.readWorkspaceRelocationRootSelected(f.data, f.id)))
              assert.equal(after.storage_root, f.target); assert.equal(after.revision, f.before.revision + 1)
              assert.equal(sha256CanonicalJson(after), rootPlan.catalog_after_sha256)
              for (const original of f.before.workspaces) {
                const actual = after.workspaces.find(item => item.workspace_id === original.workspace_id)
                const mapping = rootPlan.catalog_mappings.find(item => item.workspace_id === original.workspace_id)
                assert.deepEqual(actual, { ...original, root: mapping?.after_root ?? original.root })
              }
              assert.equal((await files.selectRoot()).dispatch, 'observe'); assert.deepEqual(fs.readFileSync(selectedFile), selectedBytes)
              assert.deepEqual(await new WorkspaceCatalog({ dataRoot: f.data, files: native }).snapshot(), after)
              assert.deepEqual(fs.readFileSync(f.ledgerFile), closedBytes); assert.deepEqual(fs.readFileSync(retirementFile), retirementBytes)
              assert.equal(fs.readFileSync(path.join(f.root, 'outside-project/kept'), 'utf8'), 'external project work')
              assert.equal(fs.existsSync(f.before.storage_root), false)
              assert.equal(workspaceMaintenancePending(f.data), true)
              if (mode === 'Root publish') {
                const verifySelected = async () => {
                  const journal = createWorkspaceFileJournal(child, context)
                  try { return await journal.verifySelectedRoot() } finally { journal.close() }
                }
                const expectedProof = { selected_sha256: selected.selected_sha256, worker_commit_sha256: closedEvidence.worker_commit_sha256,
                  recovery_commit_sha256: closedEvidence.recovery_commit_sha256 }
                assert.deepEqual(await verifySelected(), expectedProof)
                await assert.rejects(rootRecords.verifyWorkspaceRelocationSelectedRoot({ dataDir: f.data, id: f.id }))
                const invalid = createWorkspaceJournalClient(child, context, 'file')
                try { await assert.rejects(invalid.call('verify_selected_root', { directory: f.root })) } finally { invalid.close() }
                const probe = path.join(f.target, '.owned-health-probe')
                fs.writeFileSync(probe, 'finite probe'); fs.unlinkSync(probe)
                assert.deepEqual(await verifySelected(), expectedProof)
                const catalogPath = path.join(control, 'catalog.json'), catalogBytes = fs.readFileSync(catalogPath)
                try {
                  const changed = JSON.parse(catalogBytes); changed.revision++
                  fs.writeFileSync(catalogPath, JSON.stringify(changed))
                  await assert.rejects(verifySelected())
                } finally { fs.writeFileSync(catalogPath, catalogBytes) }
                assert.deepEqual(await verifySelected(), expectedProof)
                const retainedSelectedRoot = f.target + '-health-kept'
                fs.renameSync(f.target, retainedSelectedRoot)
                try { fs.mkdirSync(f.target); await assert.rejects(verifySelected()) }
                finally { fs.rmdirSync(f.target); fs.renameSync(retainedSelectedRoot, f.target) }
                assert.deepEqual(await verifySelected(), expectedProof)
                const emit = child.emit; let changedWhileAwaiting = false
                const alterSelectedDuringReply = t.mock.method(child, 'emit', function(event, ...args) {
                  if (!changedWhileAwaiting && event === 'message' && args[0]?.kind === 'workspace_file_journal_reply'
                    && args[0].operation === 'verify_selected_root' && args[0].ok === true) {
                    changedWhileAwaiting = true
                    fs.writeFileSync(selectedFile, JSON.stringify({ ...JSON.parse(selectedBytes), catalog_revision: -1 }))
                  }
                  return emit.call(this, event, ...args)
                })
                try { await assert.rejects(verifySelected()); assert.equal(changedWhileAwaiting, true) }
                finally { alterSelectedDuringReply.mock.restore(); fs.writeFileSync(selectedFile, selectedBytes) }
                assert.deepEqual(await verifySelected(), expectedProof)
                assert.deepEqual(fs.readFileSync(selectedFile), selectedBytes)
                assert.deepEqual(fs.readFileSync(f.ledgerFile), closedBytes)
                assert.deepEqual(fs.readFileSync(retirementFile), retirementBytes)
                let privateReads = 0
                const originalRead = fs.readFileSync
                const countReads = t.mock.method(fs, 'readFileSync', function(file, ...args) {
                  if (typeof file === 'number') privateReads++
                  return originalRead.call(this, file, ...args)
                })
                try { rootRecords.readWorkspaceRelocationRootSelected(f.data, f.id) } finally { countReads.mock.restore() }
                t.diagnostic('Single selected-record graph private reads: ' + privateReads)
                assert.ok(privateReads <= 256, 'one fixed technical record graph must not repeatedly reread thousands of prerequisites: ' + privateReads)
                const upstreamFile = path.join(control, 'relocation-coordinator.json'), upstreamBytes = fs.readFileSync(upstreamFile)
                const missingFile = path.join(control, 'relocation-root-parents-complete.json'), publishedStat = fs.statSync(publishedFile, { bigint: true })
                for (const change of ['changed upstream', 'new missing record']) {
                  let changed = false
                  const mutateDuringRead = t.mock.method(fs, 'readFileSync', function(file, ...args) {
                    const result = originalRead.call(this, file, ...args)
                    if (typeof file === 'number' && !changed) {
                      const stat = fs.fstatSync(file, { bigint: true })
                      if (stat.dev === publishedStat.dev && stat.ino === publishedStat.ino) {
                        changed = true
                        if (change === 'changed upstream') fs.writeFileSync(upstreamFile, '{"invalid":"changed after its first read"}')
                        else fs.writeFileSync(missingFile, '{"invalid":"new after absence was observed"}', { flag: 'wx', mode: 0o600 })
                      }
                    }
                    return result
                  })
                  try {
                    assert.throws(() => rootRecords.readWorkspaceRelocationRootSelected(f.data, f.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
                    assert.equal(changed, true)
                  } finally {
                    mutateDuringRead.mock.restore()
                    if (change === 'changed upstream') fs.writeFileSync(upstreamFile, upstreamBytes)
                    else if (changed) fs.unlinkSync(missingFile)
                  }
                  assert.equal(sha256CanonicalJson(rootRecords.readWorkspaceRelocationRootSelected(f.data, f.id)), selected.selected_sha256)
                }
                const { locateWorkspaceRelocationHistory } = await import('../workspace-relocation-history.mjs')
                const query = { dataDir: f.data, managerKey: f.closureWorker.manager_key, workerId: f.closureWorker.worker_id, incarnationId: 'history-mainline' }
                const beforeRoot = f.closureWorker.incarnations[0].workspace, afterRoot = path.join(f.target, path.relative(f.before.storage_root, beforeRoot))
                const location = await locateWorkspaceRelocationHistory(query)
                assert.deepEqual(location, { intent_id: f.id, manager_key: query.managerKey, worker_id: query.workerId, incarnation_id: query.incarnationId, before_root: beforeRoot, after_root: afterRoot })
                assert.equal(fs.readFileSync(path.join(location.after_root, 'history.md'), 'utf8'), 'original history artifact')
                for (const change of [{ managerKey: 'other::manager' }, { workerId: 'new-worker' }, { incarnationId: 'new-incarnation' }]) assert.equal(await locateWorkspaceRelocationHistory({ ...query, ...change }), null)
                await assert.rejects(locateWorkspaceRelocationHistory({ ...query, workspace: f.target }))
                const originalStorage = process.env.WORKER_WORKSPACES_DIR
                try { process.env.WORKER_WORKSPACES_DIR = f.root; await assert.rejects(locateWorkspaceRelocationHistory(query)) }
                finally { if (originalStorage === undefined) delete process.env.WORKER_WORKSPACES_DIR; else process.env.WORKER_WORKSPACES_DIR = originalStorage }
                await f.catalog.update('default', { expected_revision: after.revision, name: 'updated after migration', description: '' })
                assert.deepEqual(await locateWorkspaceRelocationHistory(query), location)
                fs.mkdirSync(beforeRoot, { recursive: true }); fs.writeFileSync(path.join(beforeRoot, 'history.md'), 'unrelated recreated source')
                assert.deepEqual(await locateWorkspaceRelocationHistory(query), location)
                const retained = afterRoot + '-retained'
                fs.renameSync(afterRoot, retained)
                try {
                  fs.symlinkSync(retained, afterRoot, process.platform === 'win32' ? 'junction' : 'dir')
                  await assert.rejects(locateWorkspaceRelocationHistory(query))
                } finally { fs.unlinkSync(afterRoot); fs.renameSync(retained, afterRoot) }
                const retainedRoot = f.target + '-retained'
                fs.renameSync(f.target, retainedRoot)
                try { fs.mkdirSync(f.target); await assert.rejects(locateWorkspaceRelocationHistory(query)) }
                finally { fs.rmdirSync(f.target); fs.renameSync(retainedRoot, f.target) }
                assert.deepEqual(await locateWorkspaceRelocationHistory(query), location)
                const read = fs.promises.readFile, selectedBeforeRead = fs.readFileSync(selectedFile)
                // Catalog can expand a Windows short-path alias; bind the actual file, not its spelling.
                const catalogIdentity = fs.statSync(path.join(control, 'catalog.json'), { bigint: true })
                let changedDuringRead = false, pathAlias = false
                const mock = t.mock.method(fs.promises, 'readFile', async function(file, ...args) {
                  const body = await read.call(this, file, ...args)
                  if (!changedDuringRead && (typeof file === 'string' || file instanceof URL)) {
                    const actual = await fs.promises.stat(file, { bigint: true })
                    if (actual.dev === catalogIdentity.dev && actual.ino === catalogIdentity.ino) {
                      changedDuringRead = true; pathAlias = file !== path.join(control, 'catalog.json')
                      fs.writeFileSync(selectedFile, JSON.stringify({ ...JSON.parse(selectedBeforeRead), catalog_revision: -1 }))
                    }
                  }
                  return body
                })
                try {
                  assert.equal(await fs.promises.readFile(path.join(f.root, 'outside-project/kept'), 'utf8'), 'external project work')
                  assert.equal(changedDuringRead, false)
                  await assert.rejects(locateWorkspaceRelocationHistory(query)); assert.equal(changedDuringRead, true)
                }
                finally { t.diagnostic(JSON.stringify({ catalog_read_race_injected: changedDuringRead, path_alias: pathAlias })); mock.mock.restore(); fs.writeFileSync(selectedFile, selectedBeforeRead) }
                const [{ WorkerHarness }, { LedgerStore }, { WorkerContextStore }, { WorkspaceManager }, { BUILTIN_WORKER_PERMISSIONS }, { buildProjectDocTools }] = await Promise.all([
                  import('../../../crabot-agent/dist/workers/harness/harness.js'), import('../../../crabot-agent/dist/workers/harness/ledger-store.js'),
                  import('../../../crabot-agent/dist/workers/harness/context-store.js'), import('../../../crabot-agent/dist/workers/harness/workspace-manager.js'),
                  import('../../../crabot-agent/dist/workers/builtin/runtime.js'), import('../../../crabot-agent/dist/manager/tools/project-doc-tools.js'),
                ])
                const workersDir = path.join(f.data, 'agent/workers'), ledger = new LedgerStore(path.dirname(f.ledgerFile)), contexts = new WorkerContextStore(workersDir)
                const originalPermissions = { ...BUILTIN_WORKER_PERMISSIONS, storage: null }
                await contexts.write(query.workerId, { manager_key: query.managerKey, creator_friend_id: 'original-friend', principal_permissions: originalPermissions })
                const contextFile = path.join(workersDir, query.workerId, 'context.json'), contextBytes = fs.readFileSync(contextFile)
                const harness = new WorkerHarness({ ledger, workersDir, workspaces: new WorkspaceManager(path.join(f.data, 'workspaces'), f.data),
                  adapters: new Map(), defaultImpl: 'builtin', now: () => new Date().toISOString() })
                const { CodexWorkerAdapter } = await import('../../../crabot-agent/dist/workers/codex/adapter.js')
                const forbiddenNative = async () => { throw new Error('actual relocated history must not rebuild or probe a native executor') }
                const nativeReader = new CodexWorkerAdapter({ dataDir: f.nativeHistory.adapterData, codexHomeSource: path.join(f.root, 'unused-host-profile'),
                  tmux: { isAlive: forbiddenNative, killSession: forbiddenNative, capturePane: forbiddenNative },
                  readWorkspaceHistory: handle => harness.workspaceHistoryRead(handle.worker_id, handle.incarnation_id) })
                const nativeTrace = await nativeReader.readTrace(f.nativeHistory.handle)
                assert.equal(nativeTrace.events[0].summary, 'original relocated native parent history')
                assert.deepEqual(nativeTrace.nextCursor, { offset: 1 })
                assert.equal((await nativeReader.readTrace(f.nativeHistory.handle, nativeTrace.nextCursor)).events.length, 0)
                assert.deepEqual(await nativeReader.readTerminal(f.nativeHistory.handle), { kind: 'final_terminal', text: 'original retained native terminal', captured_at: '2026-10-20T00:01:00.000Z' })
                assert.equal(nativeReader.runtimes.size, 0)
                assert.equal(fs.readFileSync(f.nativeHistory.metaFile, 'utf8'), f.nativeHistory.meta)
                assert.equal(fs.readFileSync(path.join(f.target, path.relative(f.before.storage_root, f.nativeHistory.source)), 'utf8'), f.nativeHistory.body)
                const docs = principal => buildProjectDocTools({ ledger, managerKey: query.managerKey, managerPrincipalPermissions: principal,
                  readWorkerContext: id => contexts.read(id), managedWorkspace: (id, workspace) => harness.managedWorkspaceScope(id, workspace),
                  historyWorkspace: (id, incarnation) => harness.workspaceHistoryRead(id, incarnation) })[0]
                const request = { project_root: beforeRoot, operation: 'read', path: 'history.md' }
                const historyReadStarted = Date.now()
                for (const storage of [null, { workspace_path: beforeRoot, access: 'read' }, { scope: 'all', access: 'read' }]) {
                  const principal = { ...originalPermissions, storage }, beforePermission = JSON.stringify(principal)
                  const result = await docs(principal).call(request, {})
                  assert.equal(result.isError, false, result.output)
                  assert.equal(JSON.parse(result.output).content, 'original history artifact')
                  assert.equal(JSON.stringify(principal), beforePermission); assert.deepEqual(fs.readFileSync(contextFile), contextBytes)
                }
                t.diagnostic('Original qualified history document reads confirmed in ' + (Date.now() - historyReadStarted) + 'ms')
                const hiddenContext = contextFile + '-retained'
                fs.renameSync(contextFile, hiddenContext)
                try {
                  const explicitHistory = await docs({ ...originalPermissions, storage: { workspace_path: beforeRoot, access: 'read' } }).call(request, {})
                  assert.equal(explicitHistory.isError, false, explicitHistory.output)
                  assert.equal(JSON.parse(explicitHistory.output).content, 'original history artifact')
                  assert.equal((await docs(originalPermissions).call(request, {})).isError, true)
                } finally { fs.renameSync(hiddenContext, contextFile) }
                const binding = await harness.workspaceHistoryRead(query.workerId, query.incarnationId)
                await contexts.write(query.workerId, { manager_key: query.managerKey, creator_friend_id: 'other-owner', principal_permissions: originalPermissions })
                try {
                  await assert.rejects(binding.managedScope())
                  assert.equal((await docs(originalPermissions).call(request, {})).isError, true)
                } finally { fs.writeFileSync(contextFile, contextBytes) }
                fs.writeFileSync(contextFile, JSON.stringify({ ...JSON.parse(contextBytes), schema_version: 2,
                  request: { schema_version: 1, request_id: 'a'.repeat(64), source_sha256: 'b'.repeat(64), execution_scope: 'group' },
                  target_session: { channel_id: 'fixture', session_id: 'closure', type: 'group' } }))
                try { const requestBinding = await harness.workspaceHistoryRead(query.workerId, query.incarnationId); await assert.rejects(requestBinding.managedScope(), /request ownership/) }
                finally { fs.writeFileSync(contextFile, contextBytes) }
                assert.equal(await harness.workspaceHistoryRead('new-worker', query.incarnationId), null)
                const disabled = { ...originalPermissions, tool_access: { ...originalPermissions.tool_access, file_io: false } }
                assert.equal((await docs(disabled).call(request, {})).isError, true)
                assert.deepEqual(fs.readFileSync(contextFile), contextBytes)
                await f.close()
                assert.deepEqual(await locateWorkspaceRelocationHistory(query), location)
                assert.deepEqual(await nativeReader.readTrace(f.nativeHistory.handle), nativeTrace)
                assert.equal(nativeReader.runtimes.size, 0)
                assert.equal(fs.readFileSync(f.nativeHistory.metaFile, 'utf8'), f.nativeHistory.meta)
                assert.deepEqual(fs.readFileSync(f.ledgerFile), closedBytes); assert.deepEqual(fs.readFileSync(retirementFile), retirementBytes)
                assert.equal(workspaceMaintenancePending(f.data), true)
              }
            }
            return
          }
          const invalidInspection = createWorkspaceJournalClient(child, context, 'worker')
          try { await assert.rejects(invalidInspection.call('inspect_closures', { directory: f.root }), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }) } finally { invalidInspection.close() }
          const evidenceAgent = await import('../../../crabot-agent/dist/core/workspace-relocation-closed-evidence.js')
          const retainedEvidence = await evidenceAgent.inspectWorkspaceRelocationClosures({ dataDir: f.data, id: f.id, verify: async () => {} })
          retainedEvidence.verify()
          // The second read must be fresh, and must neither repair nor accept changed closure bytes.
          try {
            fs.appendFileSync(f.ledgerFile, '\n')
            assert.throws(retainedEvidence.verify, { code: 'CRABOT_WORKSPACE_CLOSED_EVIDENCE' })
            await assert.rejects(closer.inspectClosures(), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
            assert.deepEqual(fs.readFileSync(f.ledgerFile), Buffer.concat([closedBytes, Buffer.from('\n')]))
            assert.deepEqual(fs.readFileSync(recoveryCompleteFile), completeBytes)
          } finally { fs.writeFileSync(f.ledgerFile, closedBytes) }
          assert.equal(workspaceMaintenancePending(f.data), true)
        } finally { closer.close() }
      }
      const before = fs.readFileSync(path.join(f.data, 'workspace-control/relocation-file-actors.jsonl'))
      assert.equal((await files.prepareFiles()).dispatch, 'observe')
      assert.deepEqual(fs.readFileSync(path.join(f.data, 'workspace-control/relocation-file-actors.jsonl')), before)
    }
    assert.equal(fs.existsSync(f.target), false); assert.deepEqual(await f.catalog.snapshot(), f.before)
  } finally { workers.close(); modules.close(); processes.close(); files.close() }
})
