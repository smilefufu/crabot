import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { RpcError, sha256CanonicalJson } from 'crabot-shared'
import { readFileSync } from 'node:fs'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'

const native = require('../../scripts/lib/process-identity.cjs')

// Slot lifecycle units only; the same-MM SDK integration checks real jobs in CI.
function fixture() {
  const self = native.inspectProcess(process.pid), instance = randomUUID(), states = new Map<string, any>()
  const job = () => {
    const state = { intent: { id: randomUUID() }, launch: { launch_id: randomUUID(), parent: self, process: self },
      health: { root_proof: { instance_id: instance } }, completion: { intent_sha256: '1'.repeat(64), launch_sha256: '2'.repeat(64) } }
    states.set(state.intent.id, state)
    return { state, request: { intent_id: state.intent.id, launch_id: state.launch.launch_id, completion_sha256: sha256CanonicalJson(state.completion) }, token: randomUUID() }
  }
  let current = job()
  const records = {
    readCurrentWorkspaceRelocationFinalizing: () => ({ intent_id: current.request.intent_id }),
    readWorkspaceRelocationArchivedState: (_root: string, id: string) => states.get(id),
    readWorkspaceRelocationFinalizing: (_root: string, id: string) => id === current.request.intent_id ? { intent_id: id } : null,
    verifyWorkspaceRelocationArchivedCapabilities: async ({ verify }: any) => verify(),
  }
  const pinned = { openPinnedProcessRpc: async () => ({
    call: async (_method: string, params: any, options: any) => {
      if (options.authorizationBearer !== current.token || params.intent_id !== current.request.intent_id) throw new RpcError('FORBIDDEN', 'Not the current job')
      return { verified: true, ...current.request, ...current.state.completion, action: params.action }
    }, close: vi.fn(),
  }) }
  const runtime = { instance_id: instance, module_id: 'admin-web', runtime_id: randomUUID() }, quiesce = vi.fn(async () => {}), resume = vi.fn()
  const compiled = ts.transpileModule(readFileSync(path.join(__dirname, 'workspace-finalization-web.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const exports: any = {}
  runInThisContext('(function(exports, require, process) {' + compiled + '\n})')(exports, (id: string) => id.endsWith('workspace-relocation-intent.mjs') ? records : id.endsWith('pinned-process-rpc.cjs') ? pinned : require(id), process)
  const web = exports.createWorkspaceFinalizationWeb({ dataDir: path.join(tmpdir(), randomUUID()), moduleManagerPort: 1, runtimeIdentity: () => runtime, quiesce, resume })
  return { web, quiesce, resume, current: () => current, next: () => (current = job()) }
}

describe('normal Admin prepared job ownership', () => {
  it('prepares a newly authenticated canonical job without consuming an earlier unresumed result', async () => {
    const f = fixture(), first = f.current()
    const a = await f.web.prepare(first.request, first.token)
    expect(await f.web.prepare(first.request, first.token)).toBe(a)
    expect(f.quiesce).toHaveBeenCalledOnce()
    const next = f.next()
    const b = await f.web.prepare(next.request, next.token)
    expect(b).toMatchObject({ prepared: true, ...next.request })
    expect(b).not.toBe(a); expect(f.quiesce).toHaveBeenCalledTimes(2)
    await expect(f.web.prepare(first.request, first.token)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await f.web.prepare(next.request, next.token)).toBe(b)
    expect(f.resume).not.toHaveBeenCalled()
  })

  it('does not let a late earlier preparation replace or return a successor job result', async () => {
    const f = fixture(), first = f.current()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    f.quiesce.mockImplementationOnce(() => held)
    const old = f.web.prepare(first.request, first.token)
    const rejected = expect(old).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await vi.waitFor(() => expect(f.quiesce).toHaveBeenCalledOnce())
    try {
      const next = f.next(), prepared = await f.web.prepare(next.request, next.token)
      release(); await rejected
      expect(await f.web.prepare(next.request, next.token)).toBe(prepared)
      expect(f.quiesce).toHaveBeenCalledTimes(2); expect(f.resume).not.toHaveBeenCalled()
    } finally { release(); await old.catch(() => {}) }
  })
})
