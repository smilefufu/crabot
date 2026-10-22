import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import ModuleManager from './index.js'
import { canonicalizeJson } from 'crabot-shared'

// This covers real setup, native identity probes and cleanup; production limits stay in MM.
const nativeTimeout = process.platform === 'win32' ? 30_000 : 5_000

async function fixture(withChild = false, privateJournal = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-module-stop-')))
  const management = require('../../scripts/lib/desktop-management.cjs')
  const data = management.ensurePrivateDataRoot(path.join(root, 'data'))
  const reserve = http.createServer()
  await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const port = (reserve.address() as { port: number }).port
  await new Promise<void>(resolve => reserve.close(() => resolve()))
  const script = path.join(data, 'finite-module.cjs'), marker = path.join(data, 'shutdown.json')
  await fs.writeFile(script, `const fs=require('node:fs'),http=require('node:http');
    const timer=setInterval(()=>{},1000),calls=[];setTimeout(()=>process.exit(0),30000).unref();
    if(process.env.FIXTURE_DESCENDANT){const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{detached:true,stdio:'ignore'});child.unref()}
    const server=http.createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;
      const body=JSON.parse(text);calls.push(req.url);fs.writeFileSync(process.env.FIXTURE_CALLS,JSON.stringify(calls));
      const data=req.url==='/get_runtime_identity'?{instance_id:process.env.CRABOT_INSTANCE_ID,module_id:process.env.Crabot_MODULE_ID,runtime_id:process.env.CRABOT_MODULE_RUNTIME_ID}:{};
      if(req.url==='/fixture_add_child'){const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{detached:true,stdio:'ignore'});child.unref();data.pid=child.pid}
      res.end(JSON.stringify({id:body.id,success:true,data}));
      if(req.url==='/shutdown'){clearInterval(timer);setTimeout(()=>server.close(),10)}
    });server.listen(Number(process.env.Crabot_PORT),'127.0.0.1',()=>fs.writeFileSync(process.env.FIXTURE_READY,'ready'));`)
  const manager = new ModuleManager({ port: 0, modules: [], shutdown_timeout: 0.5 }, data) as any
  manager.managementOnly = false
  for (const id of ['fixture-memory', 'stopped-channel', 'admin-web']) manager.modules.set(id, {
    module_id: id, module_type: 'service', entry: id === 'admin-web' ? `"${process.execPath}" -e "setInterval(()=>{},1000);setTimeout(()=>process.exit(0),30000).unref()"` : `"${process.execPath}" "${script}"`,
    env: { FIXTURE_READY: path.join(data, 'ready'), FIXTURE_CALLS: marker, ...(withChild && id === 'fixture-memory' ? { FIXTURE_DESCENDANT: '1' } : {}) }, auto_start: false, auto_restart: true,
    skip_health_check: true, start_priority: 1, status: 'stopped', port: id === 'fixture-memory' ? port : port + 1,
  })
  await manager.startModuleProcess('fixture-memory'); await manager.startModuleProcess('admin-web')
  await vi.waitFor(async () => expect(await fs.readFile(path.join(data, 'ready'), 'utf8')).toBe('ready'))
  manager.modules.get('fixture-memory').skip_health_check = false
  let lock: string | undefined, relocation: any, jobId: string | undefined
  const locks = await import('../../scripts/lib/cli-lock.mjs')
  if (privateJournal) {
    const { WorkspaceCatalog } = await import('../../crabot-shared/dist/workspace-catalog.js')
    const native = require('../../scripts/lib/process-identity.cjs'), catalog = new WorkspaceCatalog({ dataRoot: data, files: native })
    await catalog.initialize()
    const snapshot = await catalog.snapshot()
    relocation = await import('../../scripts/lib/workspace-relocation-intent.mjs')
    lock = await locks.acquireCliLock(data, 'workspace-relocation'); jobId = randomUUID()
    await relocation.beginWorkspaceRelocationIntent({ dataDir: data, id: jobId, target: path.join(root, 'relocated'),
      expectedRevision: snapshot.revision, protectedRoots: [path.join(data, 'workspace-control')] })
    relocation.commitWorkspaceRelocationWorkers({ dataDir: data, id: jobId, workers: [] })
  } else {
    management.ensurePrivateDataRoot(path.join(data, 'workspace-control'))
    await fs.writeFile(path.join(data, 'workspace-control/relocation.json'), 'fixture')
  }
  const scope = await manager.captureWorkspaceRelocationModules()
  const journal = { prepare: vi.fn(async (modules: typeof scope) => {
    if (!relocation) return 'dispatch'
    relocation.commitWorkspaceRelocationModules({ dataDir: data, id: jobId, modules })
    return relocation.prepareWorkspaceRelocationModuleStops({ dataDir: data, id: jobId, modules }).dispatch
  }), observe: vi.fn(async (moduleId: string, processes: any) => {
    if (relocation) relocation.observeWorkspaceRelocationModuleProcesses({ dataDir: data, id: jobId, moduleId, processes })
  }), complete: vi.fn(async (results: any) => {
    if (relocation) relocation.completeWorkspaceRelocationModuleStops({ dataDir: data, id: jobId, results })
  }) }
  return { data, manager, scope, journal, marker, relocation, jobId, cleanup: async () => {
    vi.restoreAllMocks()
    for (const child of manager.processes.values()) {
      const state = manager.childStates.get(child)
      if (!state.finalizeStarted) state.termination = undefined
    }
    try { await manager.stop() } finally {
      const native = require('../../scripts/lib/process-identity.cjs'), { probeKnownProcessExit } = require('../../scripts/lib/known-process-exit.cjs')
      const processes = scope.flatMap((item: any) => item.processes)
      for (const process of processes) native.terminateKnownProcess(process)
      await vi.waitFor(() => expect(probeKnownProcessExit(processes).state).toBe('stopped'), { timeout: 5000 })
      locks.releaseCliLock(lock)
      await fs.rm(root, { recursive: true, force: true })
    }
  } }
}

describe('workspace planned execution module stops', () => {
  it('uses runtime-bound shutdown and known-scope proof while Admin stays alive', async () => {
    const f = await fixture(true), legacy = vi.spyOn(f.manager, 'terminateChildTree')
    try {
      const admin = f.manager.processes.get('admin-web')
      const result = await f.manager.requestWorkspaceRelocationModuleStops(JSON.parse(canonicalizeJson(f.scope)), f.journal)
      expect(result).toEqual({ dispatch: 'dispatch', results: [
        { module_id: 'fixture-memory', runtime_id: f.scope[0].runtime_id, shutdown: 'submitted', status: 'known_scope_exited' },
        { module_id: 'stopped-channel', shutdown: 'not_submitted', status: 'inactive' },
      ] })
      expect(JSON.parse(await fs.readFile(f.marker, 'utf8'))).toEqual(['/get_runtime_identity', '/shutdown'])
      expect(legacy).not.toHaveBeenCalled(); expect(admin.exitCode).toBeNull()
      expect(f.manager.processes.has('fixture-memory')).toBe(false)
      expect((await f.manager.runtimeRegistry.listRecords()).map((item: any) => item.module_id)).toEqual(['admin-web'])
      expect(f.manager.restartTimers.size).toBe(0)
      expect(f.scope[0].processes).toHaveLength(2)
      expect(f.journal.observe).toHaveBeenCalledWith('fixture-memory', f.scope[0].processes)
      expect(f.journal.complete).toHaveBeenCalledWith(result.results)
    } finally { await f.cleanup() }
  }, nativeTimeout)
  for (const kind of ['prepare fails', 'scope changed after acknowledgement', 'observe only', 'process observation not acknowledged']) {
    it(`does not turn uncertainty into shutdown: ${kind}`, async () => {
      const f = await fixture()
      try {
        if (kind === 'prepare fails') f.journal.prepare.mockRejectedValue(new Error('storage unavailable'))
        if (kind === 'scope changed after acknowledgement') f.journal.prepare.mockImplementation(async () => { f.manager.modules.get('fixture-memory').port++; return 'dispatch' })
        if (kind === 'observe only') f.journal.prepare.mockResolvedValue('observe')
        if (kind === 'process observation not acknowledged') f.journal.observe.mockRejectedValue(new Error('storage unavailable'))
        const pending = f.manager.requestWorkspaceRelocationModuleStops(f.scope, f.journal)
        if (kind === 'prepare fails' || kind === 'scope changed after acknowledgement') await expect(pending).rejects.toBeTruthy()
        else if (kind === 'observe only') expect(await pending).toEqual({ dispatch: 'observe', results: [] })
        else expect((await pending).results[0]).toMatchObject({ status: 'unknown', shutdown: 'not_submitted' })
        expect(f.manager.processes.get('fixture-memory').exitCode).toBeNull()
        expect(await fs.readFile(f.marker, 'utf8').catch(() => '[]')).not.toContain('/shutdown')
      } finally { f.manager.modules.get('fixture-memory').port = f.scope[0].module_port; await f.cleanup() }
    }, nativeTimeout)
  }
  it.each(['pid', 'parent', 'started', 'owner', 'executable', 'runtime_id', 'module_port'])('still rejects a changed original module/root binding: %s', async field => {
    const f = await fixture(false, true), rootPid = f.manager.processes.get('fixture-memory').pid
    try {
      const expected = f.scope.map((item: any) => {
        if (item.module_id !== 'fixture-memory') return item
        if (field === 'runtime_id') return { ...item, runtime_id: 'other-runtime' }
        if (field === 'module_port') return { ...item, module_port: item.module_port + 1 }
        return { ...item, processes: item.processes.map((process: any) => process.pid !== rootPid ? process : {
          ...process, [field]: field === 'pid' || field === 'parent' ? process[field] + 1 : 'changed-' + process[field],
        }) }
      })
      await expect(f.manager.requestWorkspaceRelocationModuleStops(expected, f.journal)).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_MODULE_SCOPE' })
      expect(f.journal.prepare).not.toHaveBeenCalled()
      expect(f.manager.processes.get('fixture-memory').exitCode).toBeNull()
      expect(await fs.readFile(f.marker, 'utf8').catch(() => '[]')).not.toContain('/shutdown')
    } finally { await f.cleanup() }
  }, nativeTimeout)

  it.each(['exit before stop', 'appear before stop', 'exit after prepare', 'appear after prepare'])('keeps the original module root and complete observation history when descendants %s', async change => {
    const f = await fixture(true, true), native = require('../../scripts/lib/process-identity.cjs')
    const { probeKnownProcessExit } = require('../../scripts/lib/known-process-exit.cjs')
    const target = f.scope.find((item: any) => item.module_id === 'fixture-memory'), rootPid = f.manager.processes.get('fixture-memory').pid
    const originalChild = target.processes.find((item: any) => item.pid !== rootPid && !target.processes.some((other: any) => other.parent === item.pid))
    let extra: any
    const update = async () => {
      if (change.startsWith('exit')) {
        expect(originalChild).toBeTruthy()
        native.terminateKnownProcess(originalChild)
        await vi.waitFor(() => expect(probeKnownProcessExit([originalChild]).state).toBe('stopped'))
      } else {
        const reply = await fetch(`http://127.0.0.1:${target.module_port}/fixture_add_child`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID() }),
        }).then(response => response.json()) as any
        await vi.waitFor(() => { extra = native.inspectProcess(reply.data.pid); expect(extra).toBeTruthy() })
        expect(target.processes.some((item: any) => item.pid === extra.parent)).toBe(true)
        expect(target.processes.some((item: any) => item.pid === extra.pid)).toBe(false)
      }
    }
    try {
      if (change.endsWith('before stop')) await update()
      else {
        const prepare = f.journal.prepare.getMockImplementation()!
        f.journal.prepare.mockImplementation(async scope => { const result = await prepare(scope); await update(); return result })
      }
      const result = await f.manager.requestWorkspaceRelocationModuleStops(f.scope, f.journal)
      expect(result.dispatch).toBe('dispatch')
      expect(result.results.find((item: any) => item.module_id === 'fixture-memory')).toMatchObject({ status: 'known_scope_exited' })
      expect(f.relocation.readWorkspaceRelocationModules(f.data, f.jobId).modules).toEqual(f.scope)
      const stored = f.relocation.readWorkspaceRelocationModuleStops(f.data, f.jobId)
      const known = stored.observations.filter((item: any) => item.module_id === 'fixture-memory').at(-1).processes
      expect(known).toEqual(expect.arrayContaining(target.processes))
      if (extra) expect(known).toEqual(expect.arrayContaining([expect.objectContaining({ pid: extra.pid, started: extra.started })]))
      expect(probeKnownProcessExit(known).state).toBe('stopped')
      expect(f.manager.processes.get('admin-web').exitCode).toBeNull()
      await expect(fs.stat(path.join(path.dirname(f.data), 'relocated'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { if (extra) native.terminateKnownProcess(extra); await f.cleanup() }
  }, nativeTimeout)

  it('joins the actual private module journal and native lock without moving workspace files', async () => {
    const f = await fixture(true, true)
    try {
      const result = await f.manager.requestWorkspaceRelocationModuleStops(f.scope, f.journal)
      const stored = f.relocation.readWorkspaceRelocationModuleStops(f.data, f.jobId)
      expect(stored.submission.results).toEqual(result.results)
      expect(stored.observations[0].processes).toEqual(f.scope[0].processes)
      expect(f.relocation.prepareWorkspaceRelocationModuleStops({ dataDir: f.data, id: f.jobId, modules: f.scope }).dispatch).toBe('observe')
      expect(f.manager.processes.get('admin-web').exitCode).toBeNull()
      expect(await fs.stat(path.join(f.data, 'workspaces/default'))).toBeTruthy()
      await expect(fs.stat(path.join(path.dirname(f.data), 'relocated'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.cleanup() }
  }, nativeTimeout)
  it('retains the actual private receipt after a lost reply and reacquires only observation authority', async () => {
    const f = await fixture(false, true), publish = f.journal.complete.getMockImplementation()!
    const locks = await import('../../scripts/lib/cli-lock.mjs')
    try {
      f.journal.complete.mockImplementation(async results => { await publish(results); throw new Error('persisted reply lost') })
      const pending = f.manager.requestWorkspaceRelocationModuleStops(f.scope, f.journal)
      await expect(pending).rejects.toThrow('persisted reply lost')
      const stored = f.relocation.readWorkspaceRelocationModuleStops(f.data, f.jobId)
      expect(stored.submission.results[0].status).toBe('known_scope_exited')
      locks.releaseCliLock(path.join(f.data, 'cli.lock'))
      const recovered = await locks.acquireWorkspaceRelocationLock(f.data, f.jobId)
      try {
        expect(f.relocation.prepareWorkspaceRelocationModuleStops({ dataDir: f.data, id: f.jobId, modules: f.scope }).dispatch).toBe('observe')
        expect(f.relocation.readWorkspaceRelocationModuleStops(f.data, f.jobId).submission).toEqual(stored.submission)
        expect(f.manager.requestWorkspaceRelocationModuleStops(f.scope, f.journal)).toBe(pending)
        await expect(pending).rejects.toThrow('persisted reply lost')
      } finally { locks.releaseCliLock(recovered) }
      expect(JSON.parse(await fs.readFile(f.marker, 'utf8'))).toEqual(['/get_runtime_identity', '/shutdown'])
    } finally { await f.cleanup() }
  }, nativeTimeout)
  it.each(['normal', 'lock lost', 'receipt reply lost', 'false persistence ack', 'capture only', 'capture false ack', 'capture lock lost', 'capture reply lost', 'captured scope then stopped descendant'])('uses the independent coordinator native lock for the real module journal across IPC: %s', async mode => {
    const f = await fixture(true, true)
    const locks = await import('../../scripts/lib/cli-lock.mjs'), native = require('../../scripts/lib/process-identity.cjs')
    const { sha256CanonicalJson } = await import('crabot-shared')
    const entry = new URL('../../scripts/lib/workspace-coordinator-entry.mjs', import.meta.url).href
    const bridge = new URL('../../scripts/lib/workspace-module-journal.mjs', import.meta.url).href
    const code = `import{enterWorkspaceRelocationCoordinator}from ${JSON.stringify(entry)};import{serveWorkspaceModuleJournal}from ${JSON.stringify(bridge)};
      const context=await enterWorkspaceRelocationCoordinator(),server=['false persistence ack','capture false ack'].includes(${JSON.stringify(mode)})?{close(){}}:serveWorkspaceModuleJournal(context);
      if(['false persistence ack','capture false ack'].includes(${JSON.stringify(mode)}))process.on('message',message=>{if(message.kind==='workspace_module_journal_request')process.send({kind:'workspace_module_journal_reply',request_id:message.request_id,launch_id:message.launch_id,operation:message.operation,ok:true,result:message.operation==='prepare'?'dispatch':true})});
      if(['receipt reply lost','capture reply lost'].includes(${JSON.stringify(mode)})){const send=process.send.bind(process),lost=${JSON.stringify(mode)}==='capture reply lost'?'capture':'complete';process.send=(message,callback)=>message.kind==='workspace_module_journal_reply'&&message.operation===lost?(callback?.(null),false):send(message,callback)}
      if(['lock lost','capture lock lost'].includes(${JSON.stringify(mode)}))context.release();
      process.send({kind:'fixture-serving'});process.on('message',m=>{if(m.kind==='fixture-exit'){server.close();context.release();process.exit(0)}});setTimeout(()=>process.exit(2),30000);`
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let output = ''; child.stderr.on('data', bytes => { output += bytes.toString() })
    const exited = once(child, 'exit'); void exited.catch(() => {})
    let journal: any
    try {
      await once(child, 'spawn')
      const launchId = randomUUID(), launch = f.relocation.commitWorkspaceRelocationCoordinator({ dataDir: f.data, id: f.jobId, launchId, coordinator: native.inspectProcess(child.pid) })
      const messages: any[] = []; child.on('message', message => messages.push(message))
      locks.releaseCliLock(path.join(f.data, 'cli.lock'))
      child.send({ kind: 'workspace_relocation_start', data_dir: f.data, intent_id: f.jobId, launch_id: launchId, launch_sha256: sha256CanonicalJson(launch) })
      await vi.waitFor(() => expect(messages.some(item => item.kind === 'fixture-serving'), output).toBe(true), { timeout: 10000 })
      const { createWorkspaceModuleJournal } = await import('../../scripts/lib/workspace-module-journal.mjs')
      journal = createWorkspaceModuleJournal(child, { dataDir: f.data, id: f.jobId, launch })
      expect(locks.cliLockToken(path.join(f.data, 'cli.lock'))).toBeUndefined()
      expect(() => f.relocation.commitWorkspaceRelocationModules({ dataDir: f.data, id: f.jobId, modules: f.scope })).toThrow()
      if (mode.startsWith('capture ')) {
        const captured = journal.capture(f.scope)
        if (mode === 'capture only') await captured
        else await expect(captured).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
        const fixed = f.relocation.readWorkspaceRelocationModules(f.data, f.jobId)
        if (mode === 'capture only' || mode === 'capture reply lost') {
          expect(fixed.modules).toEqual(f.scope)
          expect(f.relocation.readWorkspaceRelocationModuleStops(f.data, f.jobId).attempt).toBeNull()
          if (mode === 'capture only') { await journal.capture(f.scope); expect(f.relocation.readWorkspaceRelocationModules(f.data, f.jobId)).toEqual(fixed) }
        } else expect(fixed).toBeNull()
        expect(f.manager.processes.get('fixture-memory').exitCode).toBeNull()
        expect(f.manager.processes.get('admin-web').exitCode).toBeNull()
        await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-active/relocation-module-stop-attempt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await fs.readFile(f.marker, 'utf8').catch(() => '[]')).not.toContain('/shutdown')
        return
      }
      if (mode === 'captured scope then stopped descendant') {
        await journal.capture(f.scope)
        expect(f.relocation.readWorkspaceRelocationModuleStops(f.data, f.jobId).attempt).toBeNull()
        const module = f.scope.find((item: any) => item.module_id === 'fixture-memory'), rootPid = f.manager.processes.get('fixture-memory').pid
        const descendant = module.processes.find((item: any) => item.pid !== rootPid && !module.processes.some((other: any) => other.parent === item.pid))
        expect(descendant).toBeTruthy()
        native.terminateKnownProcess(descendant)
        const { probeKnownProcessExit } = require('../../scripts/lib/known-process-exit.cjs')
        await vi.waitFor(() => expect(probeKnownProcessExit([descendant]).state).toBe('stopped'))
      }
      const pending = f.manager.requestWorkspaceRelocationModuleStops(f.scope, journal)
      if (mode === 'lock lost' || mode === 'false persistence ack') {
        await expect(pending).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
        expect(f.relocation.readWorkspaceRelocationModules(f.data, f.jobId)).toBeNull()
        await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-active/relocation-module-stop-attempt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(f.manager.processes.get('fixture-memory').exitCode).toBeNull()
        expect(await fs.readFile(f.marker, 'utf8').catch(() => '[]')).not.toContain('/shutdown')
      } else {
        if (mode === 'receipt reply lost') {
          await expect(pending).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
          expect(f.manager.requestWorkspaceRelocationModuleStops(f.scope, journal)).toBe(pending)
          await expect(pending).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
        } else {
          const result = await pending
          expect(f.relocation.readWorkspaceRelocationModuleStops(f.data, f.jobId).submission.results).toEqual(result.results)
        }
        const stored = f.relocation.readWorkspaceRelocationModuleStops(f.data, f.jobId)
        expect(stored.observations[0].processes).toEqual(f.scope[0].processes)
        expect(stored.submission.results[0].status).toBe('known_scope_exited')
        journal.close()
        await expect(locks.acquireWorkspaceRelocationLock(f.data, f.jobId, 0)).rejects.toThrow(/another crabot CLI operation/)
        expect(JSON.parse(await fs.readFile(f.marker, 'utf8'))).toEqual(['/get_runtime_identity', '/shutdown'])
      }
      expect(f.manager.processes.get('admin-web').exitCode).toBeNull()
      await expect(fs.stat(path.join(path.dirname(f.data), 'relocated'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      journal?.close()
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
      await f.cleanup()
    }
  }, 30000)
  it('keeps an unplanned maintenance crash out of the legacy tree fallback', async () => {
    const f = await fixture(), legacy = vi.spyOn(f.manager, 'terminateChildTree')
    const child = f.manager.processes.get('fixture-memory'), state = f.manager.childStates.get(child)
    try {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; await state.finalized
      expect(legacy).not.toHaveBeenCalled()
      expect(state.finalizeError).toMatchObject({ code: 'CRABOT_WORKSPACE_MODULE_SCOPE' })
      expect(f.manager.processes.get('fixture-memory')).toBe(child)
      expect((await f.manager.runtimeRegistry.listRecords()).some((item: any) => item.runtime_id === state.runtimeId)).toBe(true)
    } finally {
      if (child.exitCode !== null || child.signalCode !== null) f.manager.processes.delete('fixture-memory')
      await f.cleanup()
    }
  }, nativeTimeout)
  it('never submits again after the result acknowledgement is lost', async () => {
    const f = await fixture()
    try {
      f.journal.complete.mockRejectedValue(new Error('result reply lost'))
      const first = f.manager.requestWorkspaceRelocationModuleStops(f.scope, f.journal)
      await expect(first).rejects.toThrow('result reply lost')
      expect(f.manager.requestWorkspaceRelocationModuleStops(f.scope, f.journal)).toBe(first)
      await expect(first).rejects.toThrow('result reply lost')
      expect(f.journal.prepare).toHaveBeenCalledTimes(1)
      expect(JSON.parse(await fs.readFile(f.marker, 'utf8'))).toEqual(['/get_runtime_identity', '/shutdown'])
    } finally { await f.cleanup() }
  }, nativeTimeout)
})
