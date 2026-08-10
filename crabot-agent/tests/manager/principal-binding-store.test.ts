import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PrincipalBindingStore } from '../../src/manager/principal-binding-store.js'
import { ManagerPrincipalStore } from '../../src/manager/principal.js'
import type { Friend } from '../../src/types.js'

const key = 'wechat::private-1' as const
const friend = (permission: 'master' | 'normal'): Friend => ({ id: 'f-1', display_name: 'f', permission, channel_identities: [], created_at: '', updated_at: '' })

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

})
