import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { once } from 'node:events'
import ModuleManager from './index.js'

describe('private planned workspace validation runtime', () => {
  it.each(['planned', 'ordinary', 'invalid', 'invalid recovery', 'unregistered recovery'] as const)('keeps the actual finite runtime identity bound to its owner: %s', async mode => {
    const data = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'workspace-runtime-plan-')))
    const script = path.join(data, 'finite.cjs'), observed = path.join(data, 'observed.json')
    await fs.writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(observed)}, JSON.stringify({runtime_id:process.env.CRABOT_MODULE_RUNTIME_ID}));setTimeout(()=>process.exit(0),30000)`)
    const mm = new ModuleManager({ modules: [], shutdown_timeout: 0.1 }, data) as any
    const runtime = { module_id: 'memory-default', module_type: 'memory', entry: `"${process.execPath}" "${script}"`, cwd: data, port: 19801,
      auto_start: false, auto_restart: false, skip_health_check: true, status: 'stopped' }
    mm.modules.set(runtime.module_id, runtime)
    const plannedId = mode === 'invalid' ? 'not-a-runtime-uuid' : randomUUID(), permit = Object.freeze({})
    const fence = path.join(data, 'workspace-control/relocation-finalizing.json')
    let finiteIdentity: any
    try {
      if (mode !== 'ordinary') {
        await fs.mkdir(path.dirname(fence)); await fs.writeFile(fence, 'test-owned-fence')
        mm.workspaceValidationPermits.set(permit, { moduleId: runtime.module_id, runtime, runtimeId: plannedId, ...(mode.includes('recovery') ? { recoveryId: mode === 'invalid recovery' ? 'bad-recovery-id' : randomUUID() } : {}), assertCurrent: () => {}, verify: async () => {} })
      }
      if (mode === 'invalid' || mode === 'invalid recovery') {
        await expect(mm.startModuleProcess(runtime.module_id, undefined, undefined, permit)).rejects.toMatchObject({ code: 'FORBIDDEN' })
        expect(mm.processes.size).toBe(0)
        await expect(fs.lstat(observed)).rejects.toMatchObject({ code: 'ENOENT' })
      } else if (mode === 'unregistered recovery') {
        await expect(mm.startModuleProcess(runtime.module_id, undefined, undefined, permit)).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_RUNTIME_GATE' })
        await expect(fs.lstat(observed)).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        await mm.startModuleProcess(runtime.module_id, undefined, { CRABOT_MODULE_RUNTIME_ID: 'caller-cannot-pick-runtime' }, mode === 'planned' ? permit : undefined)
        let result: any
        await vi.waitFor(async () => { result = JSON.parse(await fs.readFile(observed, 'utf8')); expect(result.runtime_id).toBeTruthy() }, { timeout: 15000 })
        const child = mm.processes.get(runtime.module_id), state = mm.childStates.get(child), records = await mm.runtimeRegistry.listRecords()
        finiteIdentity = require('../../scripts/lib/process-identity.cjs').inspectProcess(child.pid)
        expect(finiteIdentity).toBeTruthy()
        expect(result.runtime_id).toBe(state.runtimeId)
        expect(records).toEqual([expect.objectContaining({ runtime_id: state.runtimeId, root_pid: child.pid, module_id: runtime.module_id })])
        if (mode === 'planned') expect(result.runtime_id).toBe(plannedId)
        else { expect(result.runtime_id).not.toBe(plannedId); expect(result.runtime_id).not.toBe('caller-cannot-pick-runtime') }
      }
    } finally {
      mm.workspaceValidationPermits.delete(permit)
      if (mode !== 'ordinary') await fs.unlink(fence)
      await mm.stop()
      if (finiteIdentity) expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([finiteIdentity]).state).toBe('stopped')
      await fs.rm(data, { recursive: true, force: true })
    }
  }, process.platform === 'win32' ? 120000 : 30000)
})


describe('current recovery child shutdown connection', () => {
  it('opens its one fixed shutdown connection after the initial guarded tree observation', async () => {
    const data = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'workspace-shutdown-idle-')))
    const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening')
    const port = (reservation.address() as { port: number }).port
    await new Promise<void>(resolve => reservation.close(() => resolve()))
    const script = path.join(data, 'finite-service.cjs'), ready = path.join(data, 'ready'), calls = path.join(data, 'calls.json')
    await fs.writeFile(script, `const fs=require('node:fs'),http=require('node:http'),calls=[];const server=http.createServer(async(req,res)=>{
      let text='';for await(const part of req)text+=part;const body=JSON.parse(text);calls.push(body.method);fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify(calls));
      const data=body.method==='get_runtime_identity'?{instance_id:process.env.CRABOT_INSTANCE_ID,module_id:'finite-memory',runtime_id:process.env.CRABOT_MODULE_RUNTIME_ID}:{};
      res.end(JSON.stringify({id:body.id,success:true,data}));if(body.method==='shutdown')setTimeout(()=>process.exit(0),25);
    });server.keepAliveTimeout=5000;server.keepAliveTimeoutBuffer=0;server.listen(Number(process.env.Crabot_PORT),'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(ready)},'ready'));
    setTimeout(()=>process.exit(0),30000);`)
    const manager = new ModuleManager({ modules: [], shutdown_timeout: 1 }, data) as any
    manager.modules.set('finite-memory', { module_id: 'finite-memory', module_type: 'memory', entry: `"${process.execPath}" "${script}"`, cwd: data, port,
      auto_start: false, auto_restart: false, skip_health_check: false, status: 'stopped' })
    const stopper = require('../../scripts/lib/known-process-stop.cjs'), original = stopper.stopKnownProcessScope
    const slowObservation = vi.spyOn(stopper, 'stopKnownProcessScope').mockImplementation(async (...args: any[]) => {
      await new Promise(resolve => setTimeout(resolve, 5500))
      return original(...args)
    })
    try {
      await manager.startModuleProcess('finite-memory')
      await vi.waitFor(async () => expect(await fs.readFile(ready, 'utf8')).toBe('ready'), { timeout: 15000 })
      const child = manager.processes.get('finite-memory'), state = manager.childStates.get(child)
      await manager.stopWorkspaceRecoveryChild('finite-memory', child, state, async () => {}, () => {})
      expect(JSON.parse(await fs.readFile(calls, 'utf8'))).toEqual(['get_runtime_identity', 'shutdown'])
      expect(manager.processes.size).toBe(0)
      expect(await manager.runtimeRegistry.listRecords()).toEqual([])
    } finally {
      slowObservation.mockRestore()
      await manager.stop()
      await fs.rm(data, { recursive: true, force: true })
    }
  }, process.platform === 'win32' ? 120000 : 30000)
})
