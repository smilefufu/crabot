import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PrincipalBindingStore } from '../../src/manager/principal-binding-store.js'
import { ManagerPrincipalStore } from '../../src/manager/principal.js'
import type { Friend } from '../../src/types.js'

const key = 'wechat::private-1' as const
const friendWithId = (id: string, permission: 'master' | 'normal'): Friend => ({
  id,
  display_name: id,
  permission,
  channel_identities: [],
  created_at: '',
  updated_at: '',
})
const friend = (permission: 'master' | 'normal'): Friend => friendWithId('f-1', permission)
const permissions = {
  tool_access: { memory: false, messaging: true, task: false, mcp_skill: false, file_io: false, browser: false, shell: false, remote_exec: false, desktop: false },
  cli_access: { provider: 'none', agent: 'none', mcp: 'none', skill: 'none', schedule: 'none', channel: 'none', friend: 'none', permission: 'none', config: 'none', undo: 'none' },
  storage: null,
  memory_scopes: ['private'],
} as const

describe('principal bindings', () => {
  it('persists only private bindings, advances generation, and does not restore Admin Chat authority after restart', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'principal-bindings-'))
    try {
      const file = join(root, 'manager-principal-bindings.json')
      const store = new PrincipalBindingStore(file)
      await store.init()
      const one = await store.set({ manager_key: key, kind: 'friend', friend_id: 'f-1' })
      const adminKey = 'admin-web::admin-chat' as const
      const two = await store.set({ manager_key: adminKey, kind: 'admin_chat_jwt', assertion_id: 'local-id', expires_at: '2099-01-01T00:00:00.000Z' })
      expect(two.generation).toBe(1)
      const raw = await fs.readFile(file, 'utf8')
      expect(raw).not.toContain('permission'); expect(raw).not.toContain('JWT')
      const restarted = new PrincipalBindingStore(file); await restarted.init()
      const principal = new ManagerPrincipalStore({ resolvePermissions: async () => null, sessionMemoryScopes: async () => [], sceneProfile: async () => null, crabSelfHandle: () => undefined, getFriend: async () => friend('master') }, restarted)
      await principal.init()
      expect(principal.currentMasterAuthorization(adminKey)).toBeUndefined()
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('group human resolution never writes a durable binding; friend invalidation makes old authorization fail', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'principal-bindings-'))
    try {
      const store = new PrincipalBindingStore(join(root, 'bindings.json')); await store.init()
      let current = friend('master')
      const principal = new ManagerPrincipalStore({ resolvePermissions: async () => null, sessionMemoryScopes: async () => [], sceneProfile: async () => null, crabSelfHandle: () => undefined, getFriend: async () => current }, store)
      await principal.init()
      await principal.resolve('wechat::group' as never, { friend: friend('master'), sessionType: 'group' })
      expect(store.get('wechat::group' as never)).toBeUndefined()
      await principal.resolve(key, { friend: friend('master'), sessionType: 'private' })
      const auth = principal.currentMasterAuthorization(key)!; expect(await principal.validateMasterAuthorization(auth)).toBe(true)
      current = friend('normal'); await principal.invalidateFriend('f-1')
      expect(await principal.validateMasterAuthorization(auth)).toBe(false)
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('rejects duplicate keys, malformed IDs/kinds, non-admin Admin Chat keys, and malformed ManagerKeys on load', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'principal-bindings-invalid-'))
    try {
      const file = join(root, 'bindings.json')
      const valid = { manager_key: 'wechat::s', generation: 1, kind: 'friend', friend_id: 'f' }
      for (const bindings of [
        [valid, valid],
        [{ ...valid, friend_id: '' }],
        [{ ...valid, assertion_id: 'forbidden' }],
        [{ manager_key: 'wechat::s', generation: 1, kind: 'admin_chat_jwt', assertion_id: 'a', expires_at: '2099-01-01T00:00:00.000Z' }],
        [{ ...valid, manager_key: 'bad' }],
      ]) {
        await fs.writeFile(file, JSON.stringify({ bindings }))
        await expect(new PrincipalBindingStore(file).init()).rejects.toThrow(/invalid|duplicate/)
      }
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('synthetic Admin Chat friend resolution cannot replace active JWT authorization', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'principal-admin-chat-'))
    try {
      const store = new PrincipalBindingStore(join(root, 'bindings.json')); await store.init()
      const principal = new ManagerPrincipalStore({ resolvePermissions: async () => null, sessionMemoryScopes: async () => [], sceneProfile: async () => null, crabSelfHandle: () => undefined, getFriend: async () => friend('master') }, store)
      await principal.init()
      await principal.activateAdminChat('admin-web::admin-chat' as never, { assertionId: 'assertion', expiresAt: '2099-01-01T00:00:00.000Z' })
      const before = principal.currentMasterAuthorization('admin-web::admin-chat' as never)
      await principal.resolve('admin-web::admin-chat' as never, { friend: friend('master'), sessionType: 'private' })
      const after = principal.currentMasterAuthorization('admin-web::admin-chat' as never)
      expect(after).toEqual(before)
      expect(after?.kind).toBe('admin_chat_jwt')
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })


  it('lookup downgrade/null/throw bumps an active Friend generation once and a same-Friend regrant gets the new generation', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'principal-generation-'))
    try {
      const store = new PrincipalBindingStore(join(root, 'bindings.json')); await store.init()
      let mode: 'master' | 'normal' | 'null' | 'throw' = 'master'
      const principal = new ManagerPrincipalStore({
        resolvePermissions: async () => null, sessionMemoryScopes: async () => [], sceneProfile: async () => null, crabSelfHandle: () => undefined,
        getFriend: async () => { if (mode === 'throw') throw new Error('down'); return mode === 'null' ? null : friend(mode) },
      }, store)
      await principal.init(); await principal.resolve(key, { friend: friend('master'), sessionType: 'private' })
      const first = principal.currentMasterAuthorization(key)!; expect(first.generation).toBe(1)
      mode = 'normal'; await principal.refreshForNonHumanWake(key)
      expect(store.get(key)?.generation).toBe(2); expect(principal.currentMasterAuthorization(key)).toBeUndefined()
      await principal.refreshForNonHumanWake(key)
      expect(store.get(key)?.generation).toBe(2)
      mode = 'master'; await principal.resolve(key, { friend: friend('master'), sessionType: 'private' })
      expect(principal.currentMasterAuthorization(key)?.generation).toBe(2)
      mode = 'null'; await principal.refreshForNonHumanWake(key); expect(store.get(key)?.generation).toBe(3)
      mode = 'master'; await principal.resolve(key, { friend: friend('master'), sessionType: 'private' })
      mode = 'throw'; await principal.refreshForNonHumanWake(key); expect(store.get(key)?.generation).toBe(4)
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('legacy credentials use object identity, preserve captured generation, and require Master for cross-session use', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'principal-legacy-auth-'))
    try {
      const bindings = new PrincipalBindingStore(join(root, 'bindings.json'))
      await bindings.init()
      const friends = new Map<string, Friend>([
        ['f-1', friendWithId('f-1', 'master')],
        ['f-2', friendWithId('f-2', 'normal')],
      ])
      const principal = new ManagerPrincipalStore({
        resolvePermissions: async () => permissions,
        sessionMemoryScopes: async () => [],
        sceneProfile: async () => null,
        crabSelfHandle: () => undefined,
        getFriend: async (id) => friends.get(id) ?? null,
      }, bindings)
      await principal.init()

      const masterKey = 'wechat::master-private' as const
      const normalKey = 'wechat::normal-private' as const
      const targetKey = 'other::target' as const
      await principal.resolve(masterKey, { friend: friendWithId('f-1', 'master'), sessionType: 'private' })
      const masterTemplate = principal.captureLegacyContinuationAuth(masterKey)!
      const masterAuth = principal.bindLegacyContinuationAuth(masterTemplate, targetKey)!
      expect(await principal.validateLegacyContinuationAuth(masterAuth)).toBe(true)
      expect(await principal.validateLegacyContinuationAuth({ ...masterAuth })).toBe(false)

      await principal.resolve(normalKey, { friend: friendWithId('f-2', 'normal'), sessionType: 'private' })
      const normalTemplate = principal.captureLegacyContinuationAuth(normalKey)!
      const sameSession = principal.bindLegacyContinuationAuth(normalTemplate, normalKey)!
      expect(await principal.validateLegacyContinuationAuth(sameSession)).toBe(true)
      const normalCrossSession = principal.bindLegacyContinuationAuth(normalTemplate, targetKey)!
      expect(await principal.validateLegacyContinuationAuth(normalCrossSession)).toBe(false)
      expect(await principal.validateLegacyContinuationAuth(masterAuth)).toBe(true)

      await principal.resolve(normalKey, { friend: friendWithId('f-2', 'normal'), sessionType: 'private' })
      const stale = principal.bindLegacyContinuationAuth(normalTemplate, normalKey)!
      expect(await principal.validateLegacyContinuationAuth(stale)).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('Admin Chat legacy credentials expire and cannot be reconstructed after expiry', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'principal-legacy-admin-'))
    try {
      const bindings = new PrincipalBindingStore(join(root, 'bindings.json'))
      await bindings.init()
      let nowMs = Date.parse('2026-01-01T00:00:00.000Z')
      const principal = new ManagerPrincipalStore({
        resolvePermissions: async () => permissions,
        sessionMemoryScopes: async () => [],
        sceneProfile: async () => null,
        crabSelfHandle: () => undefined,
        getFriend: async () => friend('master'),
      }, bindings, () => new Date(nowMs))
      await principal.init()
      const adminKey = 'admin-web::admin-chat' as const
      await principal.activateAdminChat(adminKey, {
        assertionId: 'assertion',
        expiresAt: '2026-01-01T00:01:00.000Z',
      })
      await principal.resolve(adminKey, { friend: friend('master'), sessionType: 'private' })
      const auth = principal.bindLegacyContinuationAuth(
        principal.captureLegacyContinuationAuth(adminKey),
        'other::target' as const,
      )!
      expect(await principal.validateLegacyContinuationAuth(auth)).toBe(true)
      nowMs = Date.parse('2026-01-01T00:02:00.000Z')
      expect(await principal.validateLegacyContinuationAuth(auth)).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

})
