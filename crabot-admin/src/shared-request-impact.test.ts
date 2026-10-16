import { beforeEach, afterEach, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdminModule from './index.js'
import { PermissionTemplateManager } from './permission-template-manager.js'
import { impactFriendPermissions, additionalRequestCapabilities, buildSharedRequestImpact } from './shared-request-impact.js'
import { createToolAccessConfig, createCliAccessConfig } from './types.js'
let root: string
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'request-impact-')); await fs.mkdir(path.join(root, 'admin')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
const permission = () => ({ tool_access: createToolAccessConfig(true), cli_access: createCliAccessConfig('write'), storage: { workspace_path: '/B', access: 'readwrite' as const }, memory_scopes: [] as string[], updated_at: '2026-10-16T00:00:00Z' })
const friend = (kind = 'normal') => ({ id: 'friend', display_name: 'SHOULD_NOT_EXPORT_NAME', permission: kind, channel_identities: [{ channel_id: 'channel', platform_user_id: 'person', platform_display_name: 'SHOULD_NOT_EXPORT_NAME' }], created_at: 't', updated_at: 't' })
it.each(['master', 'normal'])('offline projection matches unchanged live resolver for %s, explicit config, old partial CLI and missing templates', (kind) => {
  const admin = new AdminModule({ moduleId: 'impact-test', moduleType: 'admin', version: 'test', protocolVersion: '0.1.0', port: 0 }, { data_dir: path.join(root, 'admin'), web_port: 0 }) as any
  admin.permissionTemplateManager.initSystemTemplates()
  const actor: any = friend(kind)
  for (const config of [undefined, permission(), { ...permission(), cli_access: { friend: 'read' } }]) {
    admin.friendPermissionConfigs.clear()
    if (config) admin.friendPermissionConfigs.set(actor.id, config)
    expect(impactFriendPermissions(actor as any, config as any, admin.permissionTemplateManager)).toEqual(admin.buildResolvedFriendPermissions(actor))
  }
  actor.permission_template_id = 'missing'
  admin.friendPermissionConfigs.clear()
  expect(impactFriendPermissions(actor as any, undefined, admin.permissionTemplateManager)).toEqual(admin.buildResolvedFriendPermissions(actor))
})
it('reports friend-write B without manufacturing group-write A and keeps current config byte-exact', async () => {
  const templates = new PermissionTemplateManager(); templates.initSystemTemplates()
  const group = templates.resolveGroupPermissions('group_default', { tool_access: { file_io: true }, storage: { workspace_path: '/A', access: 'read' }, updated_at: 't' })
  const personal = permission(), before = JSON.stringify({ group, personal })
  const report = additionalRequestCapabilities(group, personal, 'g')
  expect(report).toContain('storage:readwrite:/B'); expect(report).not.toContain('storage:readwrite:/A')
  expect(JSON.stringify({ group, personal })).toBe(before)
})
it('respects directory containment, tool prerequisites, CLI levels and empty Memory query filters', () => {
  const a = permission(), b = permission()
  a.storage = { workspace_path: '/', access: 'readwrite' }; b.storage = { workspace_path: '/nested', access: 'readwrite' }
  a.memory_scopes = ['g']; b.memory_scopes = ['g']
  expect(additionalRequestCapabilities(a, b, 'g')).toEqual([])
  b.memory_scopes = []; a.tool_access.shell = false; b.cli_access.friend = 'read'
  expect(additionalRequestCapabilities(a, b, 'g')).toContain('memory:additional_query_scope')
  expect(additionalRequestCapabilities(a, b, 'g')).toContain('cli:friend:read')
  b.tool_access.shell = false; b.tool_access.file_io = false
  expect(additionalRequestCapabilities(a, b, 'g').some(value => value.startsWith('cli:') || value.startsWith('storage:'))).toBe(false)
})
it('enumerates known groups and future defaults as possible same-channel actors, omits private bodies and preserves every input', async () => {
  const inputs = { 'friends.json': [friend(), { ...friend('master'), id: 'master' }],
    'friend-permission-configs.json': [{ friend_id: 'friend', config: permission() }],
    'session-configs.json': [{ channel_id: 'channel', session_id: 'g', config: { updated_at: '2026-10-16T00:00:00Z' } }] }
  for (const [name, value] of Object.entries(inputs)) await fs.writeFile(path.join(root, 'admin', name), JSON.stringify(value))
  await fs.mkdir(path.join(root, 'agent')); await fs.writeFile(path.join(root, 'agent', 'private-chat.txt'), 'PRIVATE BODY DO NOT EXPORT')
  const report = await buildSharedRequestImpact(root), text = JSON.stringify(report)
  expect(report.membership).toBe('same_channel_candidates_only')
  expect(report.managed_workspace_file_access).toMatchObject({ enabled_by: 'file_io', default_access: 'readwrite', extra_storage_unchanged: true })
  expect(report.managed_workspace_file_access.compatibility).toContain('缺快照')
  expect(report.entries.some(entry => entry.session_id === 'g' && entry.friend_id === 'friend')).toBe(true)
  expect(report.entries.some(entry => entry.session_id === null && entry.friend_id === 'master')).toBe(true)
  expect(text).not.toMatch(/PRIVATE BODY|SHOULD_NOT_EXPORT_NAME|platform_user_id|channel_identities/)
  for (const [name, value] of Object.entries(inputs)) expect(await fs.readFile(path.join(root, 'admin', name), 'utf8')).toBe(JSON.stringify(value))
})
it('marks unverified old group configs and unavailable personal templates as unknown, never zero-impact', async () => {
  await fs.writeFile(path.join(root, 'admin', 'friends.json'), JSON.stringify([{ ...friend(), permission_template_id: 'missing' }]))
  await fs.writeFile(path.join(root, 'admin', 'session-configs.json'), JSON.stringify([{ session_id: 'ambiguous', config: {} }]))
  const result = await buildSharedRequestImpact(root)
  expect(result.unknown).toContain('unverified_or_invalid_group_config'); expect(result.unknown).toContain('unavailable_friend_permissions:friend')
})
it('fails closed on malformed permission stores', async () => {
  await fs.writeFile(path.join(root, 'admin', 'friends.json'), '{bad')
  await expect(buildSharedRequestImpact(root)).rejects.toThrow()
})
