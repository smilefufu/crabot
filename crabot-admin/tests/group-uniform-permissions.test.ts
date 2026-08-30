/**
 * resolve_principal_permissions 群聊路径群级统一（与发言人无关）
 *
 * 背景：2026-08-30 决策推翻 §3.2.7 按发言人解析的群聊语义——群聊有群聊的权限，
 * master 在群里也按群档位（spec: crabot-docs/superpowers/specs/2026-08-30-group-uniform-permissions-design.md）。
 * 修复前群内 master 发言人短路拿 master_private 全量档位、普通成员取 friend∪session 并集，
 * 群内不同成员持有不同档位；该差异是 PR #131 注入路径提权问题（已单独立项消除）的前提。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import AdminModule from '../src/index.js'

const TEST_PROTOCOL_PORT = 19841
const TEST_WEB_PORT = 13041
const TEST_DATA_DIR = './test-data/admin-group-uniform-perm-test'

describe('resolvePrincipalPermissions: 群聊群级统一', () => {
  let admin: AdminModule

  beforeAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    admin = new AdminModule(
      {
        moduleId: 'admin-group-uniform-perm-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_PASSWORD_GROUPPERM',
        jwt_secret_env: 'TEST_JWT_SECRET_GROUPPERM',
        token_ttl: 3600,
      }
    )
    process.env.TEST_ADMIN_PASSWORD_GROUPPERM = 'test_password_123'
    process.env.TEST_JWT_SECRET_GROUPPERM = 'test_jwt_secret_at_least_32_chars'
    await admin.start()
  })

  afterAll(async () => {
    await admin.stop()
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  it('群聊 + master sender 不短路：按 group_default 解析，sources 无 friend 侧；同一 sender 私聊仍短路（对照）', async () => {
    const group = await (admin as any).resolvePrincipalPermissions({
      sender_friend_id: 'master',
      session_id: 'group-a',
      session_type: 'group',
    })
    expect(group.sources.friend_template_id).toBeUndefined()
    expect(group.sources.session_template_id).toBe('group_default')
    expect(group.sources.fallback).toBeUndefined()

    const priv = await (admin as any).resolvePrincipalPermissions({
      sender_friend_id: 'master',
      session_id: 'admin-chat',
      session_type: 'private',
    })
    expect(priv.sources.friend_template_id).toBe('master_private')
  })

  it('同一群内 master / 陌生 id / 不带 sender → 解析结果恒等（sender 被完全忽略）', async () => {
    const asMaster = await (admin as any).resolvePrincipalPermissions({
      sender_friend_id: 'master',
      session_id: 'group-a',
      session_type: 'group',
    })
    const asStranger = await (admin as any).resolvePrincipalPermissions({
      sender_friend_id: 'no-such-friend',
      session_id: 'group-a',
      session_type: 'group',
    })
    const asAnonymous = await (admin as any).resolvePrincipalPermissions({
      session_id: 'group-a',
      session_type: 'group',
    })
    expect(asMaster.resolved).toEqual(asStranger.resolved)
    expect(asMaster.resolved).toEqual(asAnonymous.resolved)
    expect(asMaster.sources).toEqual(asStranger.sources)
    expect(asMaster.sources).toEqual(asAnonymous.sources)
  })

  it('群聊自定义 template_id：按 session 配置解析（不再并上 friend 侧）', async () => {
    ;(admin as any).sessionConfigs.set('group-custom', {
      template_id: 'standard',
      updated_at: '2026-08-30T00:00:00.000Z',
    })
    const result = await (admin as any).resolvePrincipalPermissions({
      sender_friend_id: 'master',
      session_id: 'group-custom',
      session_type: 'group',
    })
    expect(result.sources.session_template_id).toBe('standard')
    expect(result.resolved).toEqual(
      (admin as any).permissionTemplateManager.resolvePermissions('standard', null)
    )
  })

  it('群模板缺失 → minimal 兜底（沿用降级链路）', async () => {
    ;(admin as any).sessionConfigs.set('group-broken', {
      template_id: 'no-such-template',
      updated_at: '2026-08-30T00:00:00.000Z',
    })
    const result = await (admin as any).resolvePrincipalPermissions({
      sender_friend_id: 'master',
      session_id: 'group-broken',
      session_type: 'group',
    })
    expect(result.sources.fallback).toBe('minimal')
    expect(result.resolved).toEqual(
      (admin as any).permissionTemplateManager.resolvePermissions('minimal', null)
    )
  })
})
