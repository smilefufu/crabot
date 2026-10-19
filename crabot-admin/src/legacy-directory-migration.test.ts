import { it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { planLegacyDirectoryPermissions } from './legacy-directory-migration.js'
import { PermissionTemplateManager } from './permission-template-manager.js'
import { createToolAccessConfig, createCliAccessConfig } from './types.js'
const home = fileURLToPath(new URL('../../', import.meta.url)), now = '2026-10-19T00:00:00.000Z'
const friend = (id: string) => ({ id, permission: 'normal', channel_identities: [] })
const all = { scope: 'all', access: 'readwrite' }
const independent = { tool_access: { ...createToolAccessConfig(false), file_io: true, shell: true }, cli_access: createCliAccessConfig('none'), storage: null, memory_scopes: ['unchanged'], updated_at: now }
const input = () => ({ friends: [friend('inherited'), friend('explicit'), friend('restricted')], templates: [],
  friendConfigs: [{ friend_id: 'explicit', config: independent }, { friend_id: 'restricted', config: { ...independent, storage: { workspace_path: '/limited', access: 'read' } } }],
  groups: [{ channel_id: 'channel', session_id: 'old', config: { tool_access: { file_io: true, shell: true }, updated_at: now } }],
  bindings: { bindings: [{ kind: 'group', manager_key: 'channel::without-config', generation: 1 }] } })
it('old null becomes explicit all while restrictions, flags, template inheritance and unknown identities remain', () => {
  const source = input(), before = JSON.stringify(source), plan = planLegacyDirectoryPermissions(source, now)
  expect(JSON.stringify(source)).toBe(before)
  expect(plan.friendConfigs.find(record => record.friend_id === 'inherited')).toEqual({ friend_id: 'inherited', storage_override: all })
  expect(plan.friendConfigs.find(record => record.friend_id === 'explicit')?.config).toEqual({ ...independent, storage: all })
  expect(plan.friendConfigs.find(record => record.friend_id === 'restricted')).toEqual(source.friendConfigs[1])
  expect(plan.groups).toHaveLength(2)
  expect(plan.groups[0].config).toEqual({ ...source.groups[0].config, storage: all })
  expect(plan.report).toEqual({ converted_friends: 2, converted_groups: 2, unknown_objects: 0 })
  const templates = new PermissionTemplateManager(); templates.initSystemTemplates()
  expect(templates.resolvePermissions('standard').storage).toBeNull()
  const isolated = planLegacyDirectoryPermissions({ ...source, groups: [{ session_id: 'bad', config: {} }], bindings: { bindings: [{ kind: 'group', manager_key: 'channel::bad', generation: 1 }] } }, now)
  expect(isolated.groups).toEqual([{ session_id: 'bad', config: {} }]); expect(isolated.report.unknown_objects).toBe(1)
})
it('legacy templates with an omitted storage field retain their previous effective null range during conversion', () => {
  const manager = new PermissionTemplateManager()
  const template = manager.create({ name: 'Legacy', tool_access: independent.tool_access, cli_access: independent.cli_access })
  const old = { ...template } as any; delete old.storage
  const result = planLegacyDirectoryPermissions({ friends: [{ ...friend('legacy'), permission_template_id: template.id }], templates: [old], friendConfigs: [], groups: [], bindings: { bindings: [] } }, now)
  expect(result.friendConfigs).toEqual([{ friend_id: 'legacy', storage_override: all }])
})
let temporary: string | undefined
afterEach(async () => { vi.restoreAllMocks(); if (temporary) await fs.rm(temporary, { recursive: true, force: true }); temporary = undefined })
it('actual scope transaction backs up only changed metadata, initializes v1 once and does not convert later friends', async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-directory-upgrade-'))
  const data = path.join(temporary, 'data'), admin = path.join(data, 'admin'), agent = path.join(data, 'agent')
  await fs.mkdir(admin, { recursive: true }); await fs.mkdir(agent)
  const fixture = input()
  for (const [name, value] of [['friends.json', fixture.friends], ['templates.json', fixture.templates], ['friend-permission-configs.json', fixture.friendConfigs], ['session-configs.json', fixture.groups]] as const) await fs.writeFile(path.join(admin, name), JSON.stringify(value))
  await fs.writeFile(path.join(agent, 'manager-principal-bindings.json'), JSON.stringify(fixture.bindings))
  const unrelated = path.join(data, 'workspaces/project/secret.txt'); await fs.mkdir(path.dirname(unrelated), { recursive: true }); await fs.writeFile(unrelated, 'PRIVATE CONTENT MUST NOT BE READ')
  const original = fs.readFile, reads = vi.spyOn(fs, 'readFile').mockImplementation(((name: any, ...args: any[]) => {
    if (String(name).includes(path.join(data, 'workspaces'))) throw new Error('Unrelated project read')
    return (original as any)(name, ...args)
  }) as any)
  const { describeMigration, executeMigration } = await import('../../scripts/upgrade-lib/migration-transaction.mjs')
  const description = await describeMigration(path.join(home, 'crabot-admin'), admin, null, 'v1')
  expect(description.scope.writes).toEqual(['admin/SCHEMA_VERSION', 'admin/friend-permission-configs.json', 'admin/session-configs.json'].map(value => path.normalize(value)).sort())
  let calls = 0
  const run = async (script: string, directory: string, context: any) => {
    calls++
    await promisify(execFile)(process.execPath, [script, '--data-dir=' + directory], { env: { ...process.env, CRABOT_MIGRATION_PLAN: context.plan, CRABOT_MIGRATION_PLAN_SHA256: context.planSha256 }, timeout: 10000 })
    return { exitCode: 0 }
  }
  const result = await executeMigration(description, run)
  expect(result.ok).toBe(true); expect(calls).toBe(1)
  expect(await fs.readFile(path.join(admin, 'SCHEMA_VERSION'), 'utf8')).toBe('v1\n')
  expect(JSON.parse(await fs.readFile(path.join(admin, 'friend-permission-configs.json'), 'utf8'))).toContainEqual({ friend_id: 'inherited', storage_override: all })
  const backupFiles = await fs.readdir(path.join(result.backupPath, 'admin'))
  expect(backupFiles.sort()).toEqual(['friend-permission-configs.json', 'session-configs.json'])
  await fs.writeFile(path.join(admin, 'friends.json'), JSON.stringify([...fixture.friends, friend('new')]))
  expect((await executeMigration(description, run)).ok).toBe(true); expect(calls).toBe(1)
  expect(JSON.parse(await fs.readFile(path.join(admin, 'friend-permission-configs.json'), 'utf8')).some((record: any) => record.friend_id === 'new')).toBe(false)
  reads.mockRestore(); expect(await fs.readFile(unrelated, 'utf8')).toBe('PRIVATE CONTENT MUST NOT BE READ')
})
