import { it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdminModule from './index.js'
import { parseFriendPermissionRecords, serializeFriendPermissionRecords } from './friend-permission-store.js'
import { createToolAccessConfig, createCliAccessConfig } from './types.js'
const all = { scope: 'all' as const, access: 'readwrite' as const }
it('strictly distinguishes full config and directory-only records without ignoring malformed data', () => {
  expect(parseFriendPermissionRecords([{ friend_id: 'old', storage_override: all }])).toEqual([{ friend_id: 'old', storage_override: all }])
  for (const input of [[{ friend_id: 'old', config: {}, storage_override: all }], [{ friend_id: 'old', storage_override: { ...all, workspace_path: '/' } }], [{ friend_id: 'old', storage_override: all }, { friend_id: 'old', storage_override: all }], [{ friend_id: 'old' }], {}]) expect(() => parseFriendPermissionRecords(input)).toThrow('Invalid friend permission')
})
it('actual Admin resolver retains other template changes and reset/save cannot resurrect an override', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'friend-directory-'))
  try {
  const admin = new AdminModule({ moduleId: 'admin-permission-fixture', moduleType: 'admin', version: 'test', protocolVersion: '0.1.0', port: 0 }, { data_dir: directory, web_port: 0 }) as any
  admin.saveData = vi.fn(async () => {})
  const templates = admin.permissionTemplateManager; templates.initSystemTemplates()
  const template = templates.create({ name: 'Mutable', tool_access: { ...createToolAccessConfig(false), file_io: true }, cli_access: createCliAccessConfig('none'), storage: null, memory_scopes: [] })
  const friend = { id: 'old', display_name: 'Old', permission: 'normal', permission_template_id: template.id, channel_identities: [], created_at: 't', updated_at: 't' }
  admin.friends.set(friend.id, friend); admin.friendStorageOverrides.set(friend.id, all)
  expect(await admin.handleGetFriendPermission(friend.id)).toMatchObject({ config: null, storage_override: all, resolved: { storage: all, tool_access: { shell: false } } })
  templates.update(template.id, { tool_access: { ...template.tool_access, shell: true } })
  expect(admin.buildResolvedFriendPermissions(friend).tool_access.shell).toBe(true)
  const serialized = serializeFriendPermissionRecords(admin.friendPermissionConfigs, admin.friendStorageOverrides)
  expect(parseFriendPermissionRecords(JSON.parse(JSON.stringify(serialized)))).toEqual([{ friend_id: 'old', storage_override: all }])
  await admin.handleUpdateFriendPermission(friend.id, null)
  expect(await admin.handleGetFriendPermission(friend.id)).toMatchObject({ config: null, resolved: { storage: null } })
  expect((await admin.handleGetFriendPermission(friend.id)).storage_override).toBeUndefined()
  admin.friendStorageOverrides.set(friend.id, all)
  await admin.handleUpdateFriendPermission(friend.id, { tool_access: template.tool_access, cli_access: template.cli_access, storage: null, memory_scopes: [] })
  expect(admin.friendStorageOverrides.has(friend.id)).toBe(false)
  expect((await admin.handleGetFriendPermission(friend.id)).resolved.storage).toBeNull()
  await expect(admin.handleUpdateFriendPermission(friend.id, { tool_access: template.tool_access, cli_access: template.cli_access, storage: { ...all, workspace_path: '/' }, memory_scopes: [] })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  expect(admin.saveData).toHaveBeenCalledTimes(2)
  admin.friendStorageOverrides.set(friend.id, all)
  admin.friendPermissionConfigs.delete(friend.id)
  admin.saveData.mockRejectedValueOnce(new Error('disk failure'))
  await expect(admin.handleUpdateFriendPermission(friend.id, null)).rejects.toThrow('disk failure')
  expect((await admin.handleGetFriendPermission(friend.id)).storage_override).toEqual(all)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
