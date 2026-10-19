import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminModule from './index.js'
import { groupSessionConfigKey } from './group-session-config.js'
import { createToolAccessConfig, createCliAccessConfig } from './types.js'

const source = () => ({ source_id: randomUUID(), channel_id: 'fixture-channel', session_id: 'fixture-group', session_type: 'group',
  platform_message_id: 'message-fixture', platform_user_id: 'actual-platform-user', sender_friend_id: 'actual-friend' })
describe('Complete group/requester permission sources', () => {
  let directory: string, admin: any
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-permission-'))
    admin = new AdminModule({ moduleId: 'admin-permission-fixture', moduleType: 'admin', version: 'test', protocolVersion: '0.1.0', port: 0 }, { data_dir: directory, web_port: 0 }) as any
    admin.dataLoaded = true; admin.permissionTemplateManager.initSystemTemplates()
    admin.resolvePermissionTarget = vi.fn(async p => {
      if (p.channel_id !== 'fixture-channel' || p.session_id !== 'fixture-group' || p.session_type !== 'group') throw Object.assign(new Error('Target mismatch'), { code: 'INVALID_PARAMS' })
      return { channel_id: p.channel_id, session_id: p.session_id }
    })
    admin.rpcClient.callModuleManagerSensitive = vi.fn(async (method, params, _caller, options) => {
      if (method !== 'verify_core_agent_runtime' || params.expected_module_id !== 'crabot-agent' || options.authorizationBearer !== 'trusted-core') throw Object.assign(new Error('Current core required'), { code: 'FORBIDDEN' })
      return { verified: true }
    })
    admin.friends.set('actual-friend', { id: 'actual-friend', display_name: 'Actual', permission: 'normal', channel_identities: [{ channel_id: 'fixture-channel', platform_user_id: 'actual-platform-user' }], created_at: 't', updated_at: 't' })
    admin.channelIdentityIndex.set('fixture-channel:actual-platform-user', 'actual-friend')
  })
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }) })
  const core = { authorizationBearer: 'trusted-core' }
  it('keeps group and requester resources separate and never manufactures write access to the group read directory', async () => {
    const groupPath = path.join(directory, 'group-read'), friendPath = path.join(directory, 'friend-write')
    admin.sessionConfigs.set(groupSessionConfigKey('fixture-channel', 'fixture-group'), { template_id: 'group_default', tool_access: { file_io: true }, storage: { workspace_path: groupPath, access: 'read' }, memory_scopes: ['group-scope'], updated_at: 't' })
    admin.friendPermissionConfigs.set('actual-friend', { tool_access: { ...createToolAccessConfig(false), file_io: true }, cli_access: createCliAccessConfig('none'), storage: { workspace_path: friendPath, access: 'readwrite' }, memory_scopes: ['friend-scope'], updated_at: 't' })
    const result = await admin.handleResolveRequestPermissionSources({ source: source() }, core)
    expect(result.group).toMatchObject({ kind: 'group', subject_id: 'fixture-channel::fixture-group', is_master: false, resolved: { storage: { workspace_path: groupPath, access: 'read' }, memory_scopes: ['group-scope'] } })
    expect(result.friend).toMatchObject({ kind: 'friend', subject_id: 'actual-friend', is_master: false, resolved: { storage: { workspace_path: friendPath, access: 'readwrite' }, memory_scopes: ['friend-scope'] } })
    expect(admin.resolvePermissionTarget).toHaveBeenCalled()
  })
  it('does not turn the shared Manager into Master when this requester is Master', async () => {
    admin.friends.get('actual-friend').permission = 'master'
    const before = await admin.resolvePrincipalPermissions({ ...source(), sender_friend_id: 'actual-friend' })
    const result = await admin.handleResolveRequestPermissionSources({ source: source() }, core)
    expect(result.friend.is_master).toBe(true); expect(result.friend.resolved.tool_access.shell).toBe(true)
    expect(result.group.is_master).toBe(false); expect(result.group.resolved).toEqual(before.resolved)
    const after = await admin.resolvePrincipalPermissions({ ...source(), sender_friend_id: 'actual-friend' })
    expect(after).toEqual(before)
  })
  it('keeps an old stranger public even if that platform user is now a bound Master', async () => {
    admin.friends.get('actual-friend').permission = 'master'
    const result = await admin.handleResolveRequestPermissionSources({ source: { ...source(), sender_friend_id: null } }, core)
    expect(result.friend).toBeNull(); expect(result.group.is_master).toBe(false)
  })
  it('refuses unverified callers, forged identities, changed bindings and self-reported roles', async () => {
    await expect(admin.handleResolveRequestPermissionSources({ source: source() })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(admin.handleResolveRequestPermissionSources({ source: source() }, { authorizationBearer: 'human-or-child' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    for (const [changed, code] of [[{ ...source(), sender_friend_id: 'master' }, 'FORBIDDEN'], [{ ...source(), session_type: 'private' }, 'INVALID_PARAMS'], [{ ...source(), role: 'master' }, 'INVALID_PARAMS'], [{ ...source(), source_id: 'invented' }, 'INVALID_PARAMS'], [{ ...source(), source_id: { toString: 'forged' } }, 'INVALID_PARAMS']]) {
      await expect(admin.handleResolveRequestPermissionSources({ source: changed }, core)).rejects.toMatchObject({ code })
    }
    admin.friends.get('actual-friend').channel_identities = []
    await expect(admin.handleResolveRequestPermissionSources({ source: source() }, core)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    admin.channelIdentityIndex.delete('fixture-channel:actual-platform-user')
    await expect(admin.handleResolveRequestPermissionSources({ source: source() }, core)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('fails closed when identity/permission state is unavailable', async () => {
    admin.dataLoaded = false
    await expect(admin.handleResolveRequestPermissionSources({ source: source() }, core)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    admin.dataLoaded = true
    admin.buildResolvedFriendPermissions = vi.fn(() => null)
    await expect(admin.handleResolveRequestPermissionSources({ source: source() }, core)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })
  it('verifies a real current Master request for Memory without upgrading the shared group', async () => {
    admin.friends.get('actual-friend').permission = 'master'
    const request = { request_id: 'a'.repeat(64), source: source() }
    const before = await admin.resolvePrincipalPermissions({ ...source(), sender_friend_id: 'actual-friend' })
    await expect(admin.handleVerifyMemoryAccess({ caller_kind: 'core_agent', master_request: request }, core)).resolves.toEqual({ verified: true, request_verified: true })
    expect(await admin.resolvePrincipalPermissions({ ...source(), sender_friend_id: 'actual-friend' })).toEqual(before)
    admin.friends.get('actual-friend').permission = 'normal'
    await expect(admin.handleVerifyMemoryAccess({ caller_kind: 'core_agent', master_request: request }, core)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    admin.friends.get('actual-friend').permission = 'master'; admin.channelIdentityIndex.clear()
    await expect(admin.handleVerifyMemoryAccess({ caller_kind: 'core_agent', master_request: request }, core)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('rejects malformed Memory request proofs, strangers and current Memory revocation', async () => {
    admin.friends.get('actual-friend').permission = 'master'
    const request = { request_id: 'a'.repeat(64), source: source() }
    for (const changed of [{ ...request, request_id: 'uuid-is-not-proof' }, { ...request, role: 'master' }, { ...request, source: { ...source(), session_type: 'private' } }]) {
      await expect(admin.handleVerifyMemoryAccess({ caller_kind: 'core_agent', master_request: changed }, core)).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    }
    await expect(admin.handleVerifyMemoryAccess({ caller_kind: 'core_agent', master_request: { ...request, source: { ...source(), sender_friend_id: null } } }, core)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const original = admin.buildResolvedFriendPermissions.bind(admin)
    admin.buildResolvedFriendPermissions = (friend: any) => { const result = original(friend); result.tool_access.memory = false; return result }
    await expect(admin.handleVerifyMemoryAccess({ caller_kind: 'core_agent', master_request: request }, core)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('revalidates personal authority without a live group Channel lookup, while keeping original stranger identity', async () => {
    admin.resolvePermissionTarget.mockRejectedValue(new Error('Channel offline'))
    admin.friends.get('actual-friend').permission = 'master'
    await expect(admin.handleResolveRequestPermissionSource({ source: source(), kind: 'friend' }, core)).resolves.toMatchObject({ source: { kind: 'friend', subject_id: 'actual-friend', is_master: true } })
    await expect(admin.handleVerifyMemoryAccess({ caller_kind: 'core_agent', master_request: { request_id: 'a'.repeat(64), source: source() } }, core)).resolves.toEqual({ verified: true, request_verified: true })
    await expect(admin.handleResolveRequestPermissionSource({ source: { ...source(), sender_friend_id: null }, kind: 'friend' }, core)).resolves.toEqual({ source: null })
    expect(admin.resolvePermissionTarget).not.toHaveBeenCalled()
  })
  it('resolves the group source without requiring personal identity/config availability and strictly validates the one-source request', async () => {
    const friendLookup = vi.spyOn(admin, 'resolveFriendByChannelIdentity').mockImplementation(() => { throw new Error('Personal directory unavailable') })
    await expect(admin.handleResolveRequestPermissionSource({ source: source(), kind: 'group' }, core)).resolves.toMatchObject({ source: { kind: 'group', subject_id: 'fixture-channel::fixture-group', is_master: false } })
    expect(friendLookup).not.toHaveBeenCalled()
    for (const value of [{ source: source(), kind: 'private' }, { source: source(), kind: 'group', friend_id: 'master' }, { source: { ...source(), role: 'master' }, kind: 'group' }]) {
      await expect(admin.handleResolveRequestPermissionSource(value, core)).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    }
    await expect(admin.handleResolveRequestPermissionSource({ source: source(), kind: 'friend' }, {})).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

})
