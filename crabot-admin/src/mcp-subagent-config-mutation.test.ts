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
  id, name: id, description: 'd', when_to_use: 'w', role: 'r', workflow: 'flow', deliverables: 'out',
  builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
  allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 1, provider_id: 'provider', model_id: 'model', model_role: null,
  enabled: true, is_builtin: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
})

describe('MCP and SubAgent coordinator mutations', () => {
  afterEach(async () => { while (cleanup.length) await fs.rm(cleanup.pop()!, { recursive: true, force: true }) })

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
    const runner = async (domains: any, preview: any, apply: any) => coordinator.mutateComputed(domains, preview, apply)
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
    const runner = async (domains: any, preview: any, apply: any) => coordinator.mutateComputed(domains, preview, apply)
    mcp.setMutationRunner(runner); agents.setMutationRunner(runner)
    await coordinator.initialize()

    const created = await mcp.create({ name: 'secret-mcp', command: 'node', args: ['server.js'], env: { TOKEN: 'mcp-secret' } })
    await mcp.importFromJson(JSON.stringify({ mcpServers: { imported: { command: 'python', args: ['tool.py'] } } }))
    await agents.create(subagent('created'))
    await agents.upsertById({ ...subagent('created'), description: 'changed' }, 'overwrite')
    expect((await coordinator.current()).revision).toBe(5)
    expect(events).toEqual([
      { config_revision: 2, domains: ['mcp'] }, { config_revision: 3, domains: ['mcp'] },
      { config_revision: 4, domains: ['subagents'] }, { config_revision: 5, domains: ['subagents'] },
    ])
    expect(await agents.upsertById(subagent('created'), 'skip')).toBe('skipped')
    expect((await coordinator.current()).revision).toBe(5)
    expect(mcp.get(created.id)?.env).toEqual({ TOKEN: 'mcp-secret' })
    const outboxPath = path.join(dir, 'config', 'core-agent-config-mutation-outbox.json')
    await expect(fs.readFile(outboxPath, 'utf8')).rejects.toThrow()
    expect(JSON.stringify(events)).not.toContain('mcp-secret')
  })
})
