import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CoreAgentConfigMutationCoordinator } from './core-agent-config-revision-store.js'
import { MCPServerManager } from './mcp-skill-manager.js'
import { SubAgentManager } from './subagent-manager.js'
import type { SubAgentRegistryEntry } from './types.js'

const cleanup: string[] = []
const subagent = (id: string): SubAgentRegistryEntry => ({
  id, name: id, description: 'd', when_to_use: 'w', role: 'r', workflow: 'flow', deliverables: 'out', verification: 'verify',
  builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
  allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 1, provider_id: 'provider', model_id: 'model', model_role: null,
  enabled: true, is_builtin: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
})

describe('MCP and SubAgent coordinator mutations', () => {
  afterEach(async () => { while (cleanup.length) await fs.rm(cleanup.pop()!, { recursive: true, force: true }) })

  it('allows deleting disabled entries and creating disabled subagents (runtime-noop writes)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-disabled-delete-')); cleanup.push(dir)
    const mcp = new MCPServerManager(dir); const agents = new SubAgentManager(dir)
    await mcp.initializeLoadOnly(); await agents.initializeLoadOnly()
    const snapshot = () => ({ mcp: mcp.runtimeSemanticEntries(), subagents: agents.runtimeSemanticEntries() })
    const coordinator = new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: snapshot, publishInvalidation: () => {} })
    mcp.setSemanticSnapshotProvider(snapshot); agents.setSemanticSnapshotProvider(snapshot)
    const runner = async (domains: any, preview: any, apply: any, allowRuntimeNoop?: boolean, options?: any) => coordinator.mutateComputed(domains, preview, apply, allowRuntimeNoop, options)
    mcp.setMutationRunner(runner); agents.setMutationRunner(runner)
    await coordinator.initialize()
    const server = await mcp.create({ name: 'temp', command: 'node' })
    const createdAgent = await agents.create(subagent('temp-agent'))
    // 「先停用后删除」是 Admin Web 常规两步操作：停用条目不在 runtime 投影里，
    // 删除必须允许 noop，而不是抛 'did not change semantic snapshot'。
    await mcp.update(server.id, { enabled: false })
    await agents.update(createdAgent.id, { enabled: false })
    await expect(mcp.delete(server.id)).resolves.toBeUndefined()
    await expect(agents.delete(createdAgent.id)).resolves.toBeUndefined()
    expect(mcp.get(server.id)).toBeUndefined()
    expect(agents.get(createdAgent.id)).toBeUndefined()
    await expect(agents.create({ ...subagent('off-agent'), enabled: false })).resolves.toMatchObject({ id: expect.any(String) })
  })

  it('initializes the complete preexisting MCP/SubAgent source state as revision one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mcp-subagent-initial-')); cleanup.push(dir)
    const mcp = new MCPServerManager(dir); const agents = new SubAgentManager(dir)
    await mcp.initializeLoadOnly(); await agents.initializeLoadOnly()
    await mcp.create({ name: 'existing', command: 'node', env: { TOKEN: 'existing-secret' } })
    await agents.create(subagent('existing-agent'))
    const coordinator = new CoreAgentConfigMutationCoordinator(dir, {
      readSemanticSnapshot: () => ({ mcp: mcp.runtimeSemanticEntries(), subagents: agents.runtimeSemanticEntries() }),
      publishInvalidation: () => {},
    })
    await expect(coordinator.initialize()).resolves.toMatchObject({ revision: 1 })
    const persisted = await fs.readFile(path.join(dir, 'config', 'core-agent-config-revision.json'), 'utf8')
    expect(persisted).not.toContain('existing-secret')
  })

  it('bumps only changed builtin reconciliation and fails closed on MCP/SubAgent source tampering', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mcp-subagent-reconcile-')); cleanup.push(dir)
    const mcp = new MCPServerManager(dir); const agents = new SubAgentManager(dir)
    await mcp.initializeLoadOnly(); await agents.initializeLoadOnly()
    const coordinator = new CoreAgentConfigMutationCoordinator(dir, {
      readSemanticSnapshot: () => ({ mcp: mcp.runtimeSemanticEntries(), subagents: agents.runtimeSemanticEntries() }),
      publishInvalidation: () => {},
    })
    mcp.setSemanticSnapshotProvider(() => ({ mcp: mcp.runtimeSemanticEntries(), subagents: agents.runtimeSemanticEntries() }))
    agents.setSemanticSnapshotProvider(() => ({ mcp: mcp.runtimeSemanticEntries(), subagents: agents.runtimeSemanticEntries() }))
    const runner = async (domains: any, preview: any, apply: any, allowRuntimeNoop?: boolean) => coordinator.mutateComputed(domains, preview, apply, allowRuntimeNoop)
    mcp.setMutationRunner(runner); agents.setMutationRunner(runner)
    await coordinator.initialize()
    await mcp.registerBuiltins('relative-tools')
    await agents.seedBuiltin([{ ...subagent('builtin'), is_builtin: true }])
    const changedRevision = (await coordinator.current()).revision
    await mcp.registerBuiltins('relative-tools')
    await agents.seedBuiltin([{ ...subagent('builtin'), is_builtin: true }])
    expect((await coordinator.current()).revision).toBe(changedRevision)

    const restarted = new CoreAgentConfigMutationCoordinator(dir, {
      readSemanticSnapshot: () => ({ mcp: [{ id: 'tampered' }], subagents: agents.runtimeSemanticEntries() }),
      publishInvalidation: () => {},
    })
    await expect(restarted.initialize()).rejects.toThrow('semantic fingerprint does not match committed revision')
  })

  it('rewrites legacy v1 storage only inside a coordinator mutation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-subagent-v1-rewrite-')); cleanup.push(dir)
    const legacy = subagent('legacy')
    await fs.writeFile(path.join(dir, 'subagents.json'), JSON.stringify([legacy]))
    const agents = new SubAgentManager(dir)
    await agents.initializeLoadOnly()
    const events: Array<{ config_revision: number; domains: string[] }> = []
    const snapshot = () => ({
      subagents: agents.runtimeSemanticEntries(),
      storage: agents.semanticMigrationState(),
    })
    const coordinator = new CoreAgentConfigMutationCoordinator(dir, {
      readSemanticSnapshot: snapshot,
      publishInvalidation: (event) => { events.push(event) },
    })
    agents.setSemanticSnapshotProvider(snapshot)
    agents.setMutationRunner((domains, preview, apply) => coordinator.mutateComputed(domains, preview, apply).then(() => undefined))
    await coordinator.initialize()
    expect(agents.semanticMigrationState().legacy_rewrite_pending).toBe(true)
    await agents.seedBuiltin([])
    expect((await coordinator.current()).revision).toBe(2)
    expect(events).toEqual([{ config_revision: 2, domains: ['subagents'] }])
    expect(JSON.parse(await fs.readFile(path.join(dir, 'subagents.json'), 'utf8'))).toMatchObject({ version: 2 })
    expect(agents.semanticMigrationState().legacy_rewrite_pending).toBe(false)
  })

  it('serializes concurrent MCP creates before taking the source snapshot', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mcp-concurrent-')); cleanup.push(dir)
    const mcp = new MCPServerManager(dir); const agents = new SubAgentManager(dir)
    await mcp.initializeLoadOnly(); await agents.initializeLoadOnly()
    const coordinator = new CoreAgentConfigMutationCoordinator(dir, {
      readSemanticSnapshot: () => ({ mcp: mcp.runtimeSemanticEntries(), subagents: agents.runtimeSemanticEntries() }),
      publishInvalidation: () => {},
    })
    mcp.setSemanticSnapshotProvider(() => ({ mcp: mcp.runtimeSemanticEntries(), subagents: agents.runtimeSemanticEntries() }))
    agents.setSemanticSnapshotProvider(() => ({ mcp: mcp.runtimeSemanticEntries(), subagents: agents.runtimeSemanticEntries() }))
    const runner = (domains: any, preview: any, apply: any, allowRuntimeNoop?: boolean) => coordinator.mutateComputed(domains, preview, apply, allowRuntimeNoop).then(() => undefined)
    mcp.setMutationRunner(runner); agents.setMutationRunner(runner)
    await coordinator.initialize()

    const [first, second] = await Promise.all([
      mcp.create({ name: 'one', command: 'one' }),
      mcp.create({ name: 'two', command: 'two' }),
    ])
    const [firstAgent, secondAgent] = await Promise.all([
      agents.create(subagent('one-agent')),
      agents.create(subagent('two-agent')),
    ])

    expect(mcp.list().map((entry) => entry.id).sort()).toEqual([first.id, second.id].sort())
    expect(agents.list().map((entry) => entry.id).sort()).toEqual([firstAgent.id, secondAgent.id].sort())
    expect((await coordinator.current()).revision).toBe(5)
  })

  it('coordinates runtime CRUD/imports with exact domains and never emits MCP secrets', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mcp-subagent-coordinator-')); cleanup.push(dir)
    const mcp = new MCPServerManager(dir); const agents = new SubAgentManager(dir)
    await mcp.initializeLoadOnly(); await agents.initializeLoadOnly()
    const events: Array<{ config_revision: number; domains: string[] }> = []
    const coordinator = new CoreAgentConfigMutationCoordinator(dir, {
      readSemanticSnapshot: () => ({ mcp: mcp.runtimeSemanticEntries(), subagents: agents.runtimeSemanticEntries() }),
      publishInvalidation: (event) => { events.push(event) },
    })
    mcp.setSemanticSnapshotProvider(() => ({ mcp: mcp.runtimeSemanticEntries(), subagents: agents.runtimeSemanticEntries() }))
    agents.setSemanticSnapshotProvider(() => ({ mcp: mcp.runtimeSemanticEntries(), subagents: agents.runtimeSemanticEntries() }))
    const runner = async (domains: any, preview: any, apply: any, allowRuntimeNoop?: boolean) => coordinator.mutateComputed(domains, preview, apply, allowRuntimeNoop)
    mcp.setMutationRunner(runner); agents.setMutationRunner(runner)
    await coordinator.initialize()

    const created = await mcp.create({ name: 'secret-mcp', command: 'node', args: ['server.js'], env: { TOKEN: 'mcp-secret', A: '1', B: '2' } })
    await mcp.update(created.id, { env: { B: '2', A: '1', TOKEN: 'mcp-secret' } })
    expect((await coordinator.current()).revision).toBe(2)
    await mcp.importFromJson(JSON.stringify({ mcpServers: { imported: { command: 'python', args: ['tool.py'] } } }))
    const createdAgent = await agents.create(subagent('created'))
    await agents.update(createdAgent.id, { verification: 'changed verification' })
    await agents.upsertById({ ...subagent(createdAgent.id), verification: 'changed verification', description: 'changed' }, 'overwrite')
    expect((await coordinator.current()).revision).toBe(6)
    expect(events).toEqual([
      { config_revision: 2, domains: ['mcp'] }, { config_revision: 3, domains: ['mcp'] },
      { config_revision: 4, domains: ['subagents'] }, { config_revision: 5, domains: ['subagents'] },
      { config_revision: 6, domains: ['subagents'] },
    ])
    expect(await agents.upsertById(subagent(createdAgent.id), 'skip')).toBe('skipped')
    expect((await coordinator.current()).revision).toBe(6)
    expect(mcp.get(created.id)?.env).toEqual({ B: '2', A: '1', TOKEN: 'mcp-secret' })
    const outboxPath = path.join(dir, 'config', 'core-agent-config-mutation-outbox.json')
    await expect(fs.readFile(outboxPath, 'utf8')).rejects.toThrow()
    expect(JSON.stringify(events)).not.toContain('mcp-secret')
  })
})
