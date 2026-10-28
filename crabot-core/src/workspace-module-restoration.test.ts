import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { sha256CanonicalJson } from 'crabot-shared'
import ModuleManager from './index.js'

const native = require('../../scripts/lib/process-identity.cjs')

async function availablePort(): Promise<number> {
  const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

// This tests the neutral startup primitive, not admission or a fabricated normal/recovery grant.
describe('neutral original module restoration', () => {
  it('restores only the original active channel/tool with actual new identities and health, then retains records on role loss', async () => {
    const data = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'workspace-restore-modules-')))
    const mm = new ModuleManager({ modules: [], shutdown_timeout: 0.1 }, data) as any
    mm.managementOnly = false
    const host = http.createServer((req, res) => { void mm.handleRequest(req, res) })
    host.listen(0, '127.0.0.1'); await once(host, 'listening'); mm.config.port = (host.address() as { port: number }).port
    const scopes: any[] = [], definitions = new Map(), oldChildren: ReturnType<typeof spawn>[] = []
    let current = true
    try {
      await mm.runtimeRegistry.initialize()
      for (const kind of ['channel', 'tool', 'inactive']) {
        const id = 'fixture-' + kind, port = await availablePort(), entry = path.join(data, id + '.cjs')
        await fs.writeFile(entry, kind === 'tool' ? 'setTimeout(()=>{},30000)' : `
          const http=require('node:http'),crypto=require('node:crypto');
          http.createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;const body=JSON.parse(text);
            const data=body.method==='get_runtime_identity'?{instance_id:process.env.CRABOT_INSTANCE_ID,module_id:${JSON.stringify(id)},runtime_id:process.env.CRABOT_MODULE_RUNTIME_ID}:body.method==='health'?{status:'healthy'}:{};
            res.end(JSON.stringify({id:body.id,success:true,data}));if(body.method==='shutdown')setTimeout(()=>process.exit(0),25)
          }).listen(Number(process.env.Crabot_PORT),'127.0.0.1',async()=>{
            const response=await fetch('http://127.0.0.1:'+process.env.CRABOT_MM_PORT+'/register',{method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({id:crypto.randomUUID(),source:${JSON.stringify(id)},method:'register',params:{module_id:${JSON.stringify(id)},module_type:'channel',version:'0.1.0',protocol_version:'0.1.0',port:Number(process.env.Crabot_PORT),subscriptions:[]}})});
            const result=await response.json();if(!result.success){console.error(result.error?.code);process.exit(1)}
          });setTimeout(()=>process.exit(0),30000);`)
        const definition = { module_id: id, module_type: 'channel', entry: `"${process.execPath}" "${entry}"`, port,
          auto_start: false, auto_restart: false, skip_health_check: kind === 'tool', subscriptions: [] }
        const runtime = { ...definition, status: 'stopped' }
        mm.modules.set(id, runtime); definitions.set(id, { runtime, hash: sha256CanonicalJson(definition), overrides: sha256CanonicalJson({}) })
        let old: any
        if (kind !== 'inactive') {
          const child = spawn(process.execPath, ['-e', 'process.send("ready");process.on("message",()=>process.exit(0));setTimeout(()=>process.exit(0),30000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
          oldChildren.push(child); await once(child, 'message'); old = native.inspectProcess(child.pid)
          const ended = once(child, 'exit'); child.send('finish'); await ended
          expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([old]).state).toBe('stopped')
        }
        scopes.push({ module_id: id, instance_id: mm.runtimeRegistry.getInstanceId(), module_port: port,
          ...(old ? { runtime_id: randomUUID(), root_pid: old.pid, process_start_identity: 'fixture-exited' } : {}), processes: old ? [old] : [] })
      }
      await fs.writeFile(path.join(data, 'port-allocations.json'), JSON.stringify(scopes.map(scope => ({ module_id: scope.module_id, port: scope.module_port, allocated_at: new Date().toISOString() }))))
      await mm.portAllocator.initialize()
      for (const scope of scopes) expect(mm.portAllocator.get(scope.module_id)).toBe(scope.module_port)
      const restored = await mm.restoreWorkspaceModules(scopes, definitions, { parent: native.inspectProcess(process.pid), assertCurrent: () => {
        if (!current) throw new Error('Current restoration role revoked')
      } })
      expect(restored.modules.map((item: any) => item.module_id).sort()).toEqual(['fixture-channel', 'fixture-tool'])
      expect(mm.processes.has('fixture-inactive')).toBe(false)
      const rows = await mm.runtimeRegistry.listRecords()
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(row.runtime_id).not.toBe(scopes.find(scope => scope.module_id === row.module_id).runtime_id)
        expect(mm.modules.get(row.module_id).status).toBe('running')
        expect(native.inspectProcess(row.root_pid).parent).toBe(process.pid)
      }
      restored.verify(); current = false
      expect(() => restored.verify()).toThrow('Current restoration role revoked')
      expect(await mm.runtimeRegistry.listRecords()).toEqual(rows)
    } finally {
      for (const child of oldChildren) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      let stopped = false
      try { await mm.stop(); stopped = true }
      finally {
        host.closeAllConnections(); await new Promise<void>(resolve => host.close(() => resolve()))
        if (stopped) await fs.rm(data, { recursive: true, force: true })
      }
    }
  }, process.platform === 'win32' ? 120000 : 30000)
})
