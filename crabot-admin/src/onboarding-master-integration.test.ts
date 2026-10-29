/**
 * Onboarding 自动认主 + 引导推送的 admin 内部集成测试。
 *
 * 启动一个最小化的 admin instance，直接调 private method 验证：
 * - ensureMasterForOnboarding：无 master 时新建、有 master 时合并、幂等
 * - pushOnboardingGuide：5s 内未就绪、就绪后调 RPC 链
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import type { Friend } from './types.js'

const TEST_PROTOCOL_PORT = 19811
const TEST_WEB_PORT = 13011
const TEST_DATA_DIR = './test-data/onboarding-master-integration'

describe('Onboarding auto-master + push integration', () => {
  let admin: AdminModule

  beforeAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    process.env.TEST_ADMIN_ONBOARD_MASTER_PASSWORD = 'test_password_onboard_master'
    process.env.TEST_JWT_SECRET_ONBOARD_MASTER = 'test_jwt_secret_onboard_master_at_least_32_chars'
    admin = new AdminModule(
      {
        moduleId: 'admin-onboarding-master-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_ONBOARD_MASTER_PASSWORD',
        jwt_secret_env: 'TEST_JWT_SECRET_ONBOARD_MASTER',
        token_ttl: 3600,
      },
    )
    await admin.start()
  })

  afterAll(async () => {
    await admin.stop()
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  beforeEach(async () => {
    const a = admin as any
    a.friends.clear()
    a.channelIdentityIndex.clear()
    await a.saveData()
    vi.restoreAllMocks()
  })

  describe('ensureMasterForOnboarding', () => {
    it('没有 master 时新建 Friend(permission=master)，display_name 留空待 Admin Web 引导用户填', async () => {
      const a = admin as any
      const r = await a.ensureMasterForOnboarding('feishu-a', 'ou_owner')
      expect(r).toBeTruthy()
      expect(r.created).toBe(true)
      expect(r.display_name).toBe('')
      const f = a.friends.get(r.friend_id) as Friend
      expect(f.permission).toBe('master')
      // display_name 不再默认填"主人"，由 Admin Web onboarding 卡片引导用户填
      expect(f.display_name).toBe('')
      expect(f.channel_identities).toEqual([
        { channel_id: 'feishu-a', platform_user_id: 'ou_owner', platform_display_name: '' },
      ])
      expect(a.channelIdentityIndex.size).toBe(1)
    })

    it('已有 master + 同一 channel 跨渠道复用现有 master.display_name 作 platform_display_name', async () => {
      const a = admin as any
      a.handleCreateFriend({
        display_name: '张三',
        permission: 'master',
        channel_identities: [
          { channel_id: 'telegram-a', platform_user_id: 'tg_x', platform_display_name: '张三' },
        ],
      })
      const r = await a.ensureMasterForOnboarding('feishu-a', 'ou_owner')
      expect(r.created).toBe(false)
      expect(r.display_name).toBe('张三')
      const f = a.friends.get(r.friend_id) as Friend
      // 新 channel_identity 复用现有 master.display_name 而非默认空
      const feishuIdentity = f.channel_identities.find((ci) => ci.channel_id === 'feishu-a')
      expect(feishuIdentity?.platform_display_name).toBe('张三')
    })

    it('已有 master + 不同 channel 时追加 channel_identity', async () => {
      const a = admin as any
      a.handleCreateFriend({
        display_name: 'M',
        permission: 'master',
        channel_identities: [
          { channel_id: 'telegram-a', platform_user_id: 'tg_x', platform_display_name: 'tg' },
        ],
      })
      const r = await a.ensureMasterForOnboarding('feishu-a', 'ou_owner')
      expect(r.created).toBe(false)
      const f = a.friends.get(r.friend_id) as Friend
      expect(f.channel_identities).toHaveLength(2)
      expect(f.channel_identities.find((ci: any) => ci.channel_id === 'feishu-a')?.platform_user_id).toBe('ou_owner')
    })

    it('幂等：同 channel 同 platform_user_id 不修改 updated_at', async () => {
      const a = admin as any
      await a.ensureMasterForOnboarding('feishu-a', 'ou_owner')
      const f1 = Array.from(a.friends.values())[0] as Friend
      const before = f1.updated_at
      await new Promise((r) => setTimeout(r, 2))
      const r = await a.ensureMasterForOnboarding('feishu-a', 'ou_owner')
      const f2 = a.friends.get(r.friend_id) as Friend
      expect(f2.updated_at).toBe(before)
    })

    it('同 channel 但 owner 换人：覆盖 platform_user_id 并清理旧索引', async () => {
      const a = admin as any
      await a.ensureMasterForOnboarding('feishu-a', 'ou_old')
      const oldKey = a.getChannelIdentityKey({
        channel_id: 'feishu-a', platform_user_id: 'ou_old', platform_display_name: '主人',
      })
      expect(a.channelIdentityIndex.has(oldKey)).toBe(true)

      const r = await a.ensureMasterForOnboarding('feishu-a', 'ou_new')
      expect(r.created).toBe(false)
      expect(a.channelIdentityIndex.has(oldKey)).toBe(false)
      const f = a.friends.get(r.friend_id) as Friend
      expect(f.channel_identities[0].platform_user_id).toBe('ou_new')
    })
  })

  describe('Slack uses the same Master identity and permission path as Feishu', () => {
    it('persists the verified Slack nickname and resolves Master permissions without receiving a private message', async () => {
      const a = admin as any
      const master = await a.ensureSlackOnboardingMaster('slack-one', { platform_user_id: 'UOWNER', platform_display_name: 'FuFu Z.' })
      expect(master.display_name).toBe('FuFu Z.')
      const saved = JSON.parse(await fs.readFile(`${TEST_DATA_DIR}/friends.json`, 'utf8'))
      expect(saved).toEqual([expect.objectContaining({ id: master.friend_id, permission: 'master', display_name: 'FuFu Z.', channel_identities: [{ channel_id: 'slack-one', platform_user_id: 'UOWNER', platform_display_name: 'FuFu Z.' }] })])
      a.friends.clear()
      a.channelIdentityIndex.clear()
      await a.loadData()
      const { friend } = await a.handleResolveFriend({ channel_id: 'slack-one', platform_user_id: 'UOWNER' })
      // Only the channel transport is isolated; exercise real identity, target and permission resolution.
      vi.spyOn(a, 'resolveChannelSession').mockImplementation(async (...args: unknown[]) => ({ channel_id: args[0], id: args[1], type: args[1] === 'group-one' ? 'group' : 'private' }))
      const permissions = await a.resolvePrincipalPermissions({ sender_friend_id: friend.id, channel_id: 'slack-one', session_id: 'not-yet-created-dm', session_type: 'private' })
      expect(permissions.sources.friend_template_id).toBe('master_private')
      expect(permissions.sources.fallback).toBeUndefined()
      const group = await a.resolvePrincipalPermissions({ sender_friend_id: friend.id, channel_id: 'slack-one', session_id: 'group-one', session_type: 'group' })
      expect(group.sources.session_template_id).toBe('group_default')
      expect(group.sources.friend_template_id).toBeUndefined()
    })
    it('keeps a verified identity already bound to a normal Friend instead of silently elevating it', async () => {
      const a = admin as any
      const { friend } = a.handleCreateFriend({ display_name: '普通用户', permission: 'normal', channel_identities: [{ channel_id: 'slack-one', platform_user_id: 'UOWNER', platform_display_name: '普通用户' }] })
      await a.saveData()
      const before = await fs.readFile(`${TEST_DATA_DIR}/friends.json`, 'utf8')
      expect(await a.ensureSlackOnboardingMaster('slack-one', { platform_user_id: 'UOWNER' })).toBeUndefined()
      expect(a.friends.get(friend.id).permission).toBe('normal')
      expect(await fs.readFile(`${TEST_DATA_DIR}/friends.json`, 'utf8')).toBe(before)
    })
    it('does not replace a different Master identity already managed for this channel', async () => {
      const a = admin as any
      const { friend } = a.handleCreateFriend({ display_name: '原主人', permission: 'master', channel_identities: [{ channel_id: 'slack-one', platform_user_id: 'UOLD', platform_display_name: '原主人' }] })
      expect(await a.ensureSlackOnboardingMaster('slack-one', { platform_user_id: 'UOWNER' })).toBeUndefined()
      expect(a.friends.get(friend.id)).toEqual(friend)
      expect((await a.handleResolveFriend({ channel_id: 'slack-one', platform_user_id: 'UOLD' })).friend.id).toBe(friend.id)
      expect((await a.handleResolveFriend({ channel_id: 'slack-one', platform_user_id: 'UOWNER' })).friend).toBeNull()
    })
  })

  describe('pushOnboardingGuide', () => {
    it('channel module 未就绪超时返回 false', async () => {
      const a = admin as any
      vi.spyOn(a.rpcClient, 'resolve').mockResolvedValue([])
      const ok = await a.pushOnboardingGuide('feishu-x', 'ou_y', 'https://x', {
        readyTimeoutMs: 50, pollIntervalMs: 10,
      })
      expect(ok).toBe(false)
    })

    it('happy path：调 find_or_create_private_session 再调 send_message，返回 true', async () => {
      const a = admin as any
      vi.spyOn(a.rpcClient, 'resolve').mockResolvedValue([
        { module_id: 'feishu-a', port: 27001, status: 'running' },
      ])
      const callSpy = vi.spyOn(a.rpcClient, 'call').mockImplementation(async (...args: unknown[]) => {
        const method = args[1] as string
        if (method === 'find_or_create_private_session') {
          return { session: { id: 'sess_priv_x' } }
        }
        if (method === 'send_message') {
          return {}
        }
        throw new Error(`Unexpected method: ${method}`)
      })
      const ok = await a.pushOnboardingGuide('feishu-a', 'ou_owner', 'https://open.feishu.cn/scope_url', {
        readyTimeoutMs: 200, pollIntervalMs: 10,
      })
      expect(ok).toBe(true)
      const sendCall = callSpy.mock.calls.find((c: unknown[]) => c[1] === 'send_message')
      expect(sendCall).toBeDefined()
      const sendParams = sendCall![2] as { session_id: string; content: { type: string; text: string } }
      expect(sendParams.session_id).toBe('sess_priv_x')
      expect(sendParams.content.text).toContain('https://open.feishu.cn/scope_url')
    })

    it('send_message 抛错时返回 false（吞错不上抛）', async () => {
      const a = admin as any
      vi.spyOn(a.rpcClient, 'resolve').mockResolvedValue([
        { module_id: 'feishu-a', port: 27002, status: 'running' },
      ])
      vi.spyOn(a.rpcClient, 'call').mockImplementation(async (...args: unknown[]) => {
        const method = args[1] as string
        if (method === 'find_or_create_private_session') return { session: { id: 's1' } }
        throw new Error('boom')
      })
      const ok = await a.pushOnboardingGuide('feishu-a', 'ou_y', 'https://x', {
        readyTimeoutMs: 200, pollIntervalMs: 10,
      })
      expect(ok).toBe(false)
    })

    it('module 第一次未就绪、稍后才 running：能在超时内补到 ready 并成功推送', async () => {
      const a = admin as any
      let resolveCalls = 0
      vi.spyOn(a.rpcClient, 'resolve').mockImplementation(async () => {
        resolveCalls += 1
        if (resolveCalls < 3) return [{ module_id: 'feishu-a', port: 27003, status: 'starting' }]
        return [{ module_id: 'feishu-a', port: 27003, status: 'running' }]
      })
      vi.spyOn(a.rpcClient, 'call').mockImplementation(async (...args: unknown[]) => {
        const method = args[1] as string
        if (method === 'find_or_create_private_session') return { session: { id: 's2' } }
        if (method === 'send_message') return {}
        throw new Error(`Unexpected: ${method}`)
      })
      const ok = await a.pushOnboardingGuide('feishu-a', 'ou_z', 'https://x', {
        readyTimeoutMs: 500, pollIntervalMs: 20,
      })
      expect(ok).toBe(true)
      expect(resolveCalls).toBeGreaterThanOrEqual(3)
    })
  })
})
