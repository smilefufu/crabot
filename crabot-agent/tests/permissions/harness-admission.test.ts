import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkerHarness } from '../../src/workers/harness/harness.js'
import { LedgerStore } from '../../src/workers/harness/ledger-store.js'
import { WorkspaceManager } from '../../src/workers/harness/workspace-manager.js'
import { assertExecutionPolicy } from '../../src/workers/execution-policy.js'
import { BUILTIN_WORKER_PERMISSIONS } from '../../src/workers/builtin/runtime.js'
import type { WorkerAdapter } from '../../src/workers/types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

it('production policy rejects unknown dispatch and constrained native CLI before workspace, credentials or adapter effects', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-policy-')); roots.push(root)
  const effects = { provision: vi.fn(), spawn: vi.fn(), admission: vi.fn(), credential: vi.fn() }
  const adapter = { implId: 'codex', provision: effects.provision, spawn: effects.spawn } as unknown as WorkerAdapter
  const ledger = new LedgerStore(path.join(root, 'ledgers'))
  const workspaces = new WorkspaceManager(path.join(root, 'workspaces'))
  const harness = new WorkerHarness({ adapters: new Map([['codex', adapter]]), defaultImpl: 'codex', ledger,
    workspaces, workersDir: path.join(root, 'workers'), now: () => new Date().toISOString(), onEvent() {},
    assertExecutionPolicy, admitWorkerConnection: effects.admission, issueAgentCliCredential: effects.credential,
  })
  const params = { managerKey: 'fixture::s', title: 'fixture', prompt: 'fixture', origin: { trigger_type: 'message' as const }, report_to: { channel_id: 'fixture', session_id: 's' } }
  await expect(harness.spawnWorker(params)).rejects.toMatchObject({ code: 'CAPABILITY_UNKNOWN' })
  await expect(harness.spawnWorker({ ...params, principal_permissions: { ...BUILTIN_WORKER_PERMISSIONS,
    storage: { workspace_path: root, access: 'readwrite' } } })).rejects.toMatchObject({ code: 'EXECUTION_POLICY_UNSUPPORTED' })
  for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled()
  expect(await fs.readdir(root)).toEqual([])
  expect(await ledger.listAllWorkers()).toEqual([])
})
