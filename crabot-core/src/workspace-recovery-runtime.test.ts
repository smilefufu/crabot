import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
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
