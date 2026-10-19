import { it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildManagerStack } from '../../src/manager/bootstrap.js'
import { createCrabMemoryServer } from '../../src/mcp/crab-memory.js'
import { UnifiedAgent } from '../../src/unified-agent.js'
import { BUILTIN_WORKER_PERMISSIONS } from '../../src/workers/builtin/runtime.js'
import type { SpawnSpec, WorkerAdapter } from '../../src/workers/types.js'
const home = fileURLToPath(new URL('../../../', import.meta.url))
const { default: AdminModule } = createRequire(import.meta.url)(path.join(home, 'crabot-admin/dist/index.js'))
it('real old metadata upgrade and Admin reload dispatch into an existing project with actual guarded Write/Read', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-directory-dispatch-')))
  const data = path.join(root, 'instance'), adminData = path.join(data, 'admin'), project = path.join(root, 'existing-project'), limited = path.join(root, 'limited')
  let stack: ReturnType<typeof buildManagerStack> | undefined
  try {
    await fs.mkdir(adminData, { recursive: true, mode: 0o700 }); await fs.mkdir(project); await fs.mkdir(limited)
    const admin = new AdminModule({ moduleId: 'admin-fixture', moduleType: 'admin', version: 'test', protocolVersion: '0.1.0', port: 0 }, { data_dir: adminData, web_port: 0 }) as any
    admin.permissionTemplateManager.initSystemTemplates()
    const template = admin.permissionTemplateManager.create({ name: 'Old file user', tool_access: { ...BUILTIN_WORKER_PERMISSIONS.tool_access, task: false, browser: false, remote_exec: false, desktop: false }, cli_access: BUILTIN_WORKER_PERMISSIONS.cli_access, storage: null, memory_scopes: [] })
    await fs.writeFile(path.join(adminData, 'templates.json'), JSON.stringify([template]))
    await fs.writeFile(path.join(adminData, 'friends.json'), JSON.stringify([{ id: 'owner', display_name: 'Old user', permission: 'normal', permission_template_id: template.id, channel_identities: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]))
    const { describeMigration, executeMigration } = await import('../../../scripts/upgrade-lib/migration-transaction.mjs')
    const result = await executeMigration(await describeMigration(path.join(home, 'crabot-admin'), adminData, null, 'v1'), async (script: string, directory: string, context: any) => {
      await promisify(execFile)(process.execPath, [script, '--data-dir=' + directory], { env: { ...process.env, CRABOT_MIGRATION_PLAN: context.plan, CRABOT_MIGRATION_PLAN_SHA256: context.planSha256 }, timeout: 10000 })
      return { exitCode: 0 }
    })
    expect(result.ok).toBe(true)
    await admin.loadData()
    const principal = admin.buildResolvedFriendPermissions(admin.friends.get('owner'))
    expect(principal.storage).toEqual({ scope: 'all', access: 'readwrite' })
    expect(principal.tool_access).toEqual(template.tool_access)
    const agent = Object.create(UnifiedAgent.prototype) as any
    Object.assign(agent, { config: { moduleId: 'fixture' }, agentConfig: { skills: [{ id: 'tmp-page', name: 'tmp-page', description: 'fixture', skill_dir: root }], subagents: [] },
      agentHandler: { createBuiltinBgToolOptions: () => undefined }, mcpConnector: { getAllTools: () => [] }, knownSecrets: [] })
    let spec: SpawnSpec | undefined
    const carrier = { implId: 'builtin', provision: vi.fn(async () => {}), spawn: vi.fn(async (value: SpawnSpec) => { spec = value; return { worker_id: value.worker_id, incarnation_id: value.incarnation_id, seq: 1, impl: 'builtin', session_ref: 'fixture' } }), state: async () => 'running', dispose: async () => {} } as unknown as WorkerAdapter
    vi.stubEnv('WORKER_WORKSPACES_DIR', path.join(data, 'workspaces'))
    stack = buildManagerStack({ dataRoot: data, now: () => new Date().toISOString(), managerAdapter: () => ({ async *stream() { throw new Error('No model call expected') }, updateConfig() {} }), managerModel: () => 'fixture',
      messagingDeps: {} as never, memoryServerFor: () => createCrabMemoryServer({ rpcClient: {} as never, moduleId: 'fixture', getMemoryPort: async () => 1 }, { accessContext: { actor_kind: 'conversation', memory_enabled: false }, visibility: 'internal', scopes: [], isMasterPrivate: false }),
      callAdmin: async () => ({} as never), principalResolver: {} as never, builtinSpawnDefaults: context => ({ adapter: {} as never, model: 'fixture', systemPrompt: '', tools: () => agent.buildBuiltinWorkerTools(context) }) })
    stack.adapters.set('builtin', carrier)
    // Manager notification delivery is outside this file-access test; no model turn is started.
    vi.spyOn(stack.registry, 'routeWorkerEvent').mockResolvedValue(undefined)
    const params = { managerKey: 'fixture::session' as const, title: 'Existing project', prompt: 'Create file', origin: { trigger_type: 'message' as const, creator_friend_id: 'owner' }, report_to: { channel_id: 'fixture', session_id: 'session' }, workspace: project, principal_permissions: principal }
    const worker = await stack.harness.spawnWorker(params)
    expect(worker.incarnations[0].workspace).toBe(project)
    const tools = (spec!.builtin!.tools as () => any[])(), file = path.join(project, 'actual-result.txt')
    expect((await tools.find(tool => tool.name === 'Write').call({ file_path: file, content: 'Old project remains usable' }, {})).isError).toBe(false)
    expect((await tools.find(tool => tool.name === 'Read').call({ file_path: file }, {})).output).toContain('Old project remains usable')
    expect(await fs.readFile(file, 'utf8')).toBe('Old project remains usable')
    const calls = vi.mocked(carrier.spawn).mock.calls.length
    await expect(stack.harness.spawnWorker({ ...params, principal_permissions: { ...principal, storage: { workspace_path: limited, access: 'readwrite' } } })).rejects.toThrow('PERMISSION_DENIED')
    expect(vi.mocked(carrier.spawn).mock.calls).toHaveLength(calls)
    expect(await fs.readFile(file, 'utf8')).toBe('Old project remains usable')
    await fs.unlink(path.join(adminData, 'friend-permission-configs.json'))
    await expect(admin.loadData()).rejects.toThrow('Admin 权限文件缺失')
  } finally { await stack?.dispose(); vi.unstubAllEnvs(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) }
})
