import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminModule from './index.js'
import { PermissionTemplateManager } from './permission-template-manager.js'
import { createCliAccessConfig, createToolAccessConfig } from './types.js'

const target = { channel_id: 'channel-a', session_id: 'same-id' }

describe('group permission authorization boundary', () => {
  let admin: any
  let templates: PermissionTemplateManager

  beforeEach(() => {
    templates = new PermissionTemplateManager()
    templates.initSystemTemplates()
    admin = Object.create(AdminModule.prototype)
    Object.assign(admin, {
      commitPermissionChange: (apply: () => Promise<unknown>) => apply(),
      sessionConfigs: new Map(),
      friends: new Map(),
      friendPermissionConfigs: new Map(),
      permissionTemplateManager: templates,
      dataLoaded: true,
      channelManager: { listInstances: vi.fn(() => ({ items: [{ id: 'channel-a' }, { id: 'channel-b' }] })) },
      resolveChannelSession: vi.fn(async (channel_id, id) => ({ channel_id, id, type: 'group' })),
      saveData: vi.fn(async () => {}),
      atomicWriteFile: vi.fn(async () => {}),
      publishAdminEvent: vi.fn(),
    })
  })

  it('default groups have only memory and messaging, regardless of the sender', async () => {
    const result = await admin.resolvePrincipalPermissions({ ...target, session_type: 'group', sender_friend_id: 'master' })
    expect(result.resolved.tool_access).toEqual({ ...createToolAccessConfig(false), memory: true, messaging: true })
    expect(result.resolved.cli_access).toEqual(createCliAccessConfig('none'))
    expect(result.sources.friend_template_id).toBeUndefined()
  })

  it('preserves stored retired fields on omission, rejects a changed value with INVALID_PARAMS and never persists the rejection', async () => {
    const { groupSessionConfigKey } = await import('./group-session-config.js')
    admin.sessionConfigs.set(groupSessionConfigKey(target.channel_id, target.session_id), { tool_access: { task: true, browser: false } })
    const updated = await admin.handleUpdateGroupSessionConfig({ ...target, config: { tool_access: { shell: true } } })
    expect(updated.config.tool_access).toMatchObject({ task: true, browser: false, shell: true })
    admin.atomicWriteFile.mockClear()
    let error: unknown
    try { await admin.handleUpdateGroupSessionConfig({ ...target, config: { tool_access: { task: false } } }) } catch (caught) { error = caught }
    const { formatHandlerError } = await import('crabot-shared/dist/module-base.js')
    expect(formatHandlerError(error, 'fixture').error?.code).toBe('INVALID_PARAMS')
    expect(admin.atomicWriteFile).not.toHaveBeenCalled()
  })

  it('keeps equal session IDs in different channels separate and inherits undeclared fields', async () => {
    await admin.handleUpdateGroupSessionConfig({ ...target, config: {
      template_id: 'group_scheduler', tool_access: { mcp_skill: true, desktop: true }, cli_access: { schedule: 'none', config: 'read' },
    } })
    const a = await admin.resolvePrincipalPermissions({ ...target, session_type: 'group' })
    const b = await admin.resolvePrincipalPermissions({ ...target, channel_id: 'channel-b', session_type: 'group' })
    expect(a.resolved.tool_access).toMatchObject({ memory: true, messaging: true, task: true, mcp_skill: true, desktop: false })
    expect(a.resolved.cli_access).toEqual({ ...createCliAccessConfig('none'), config: 'read' })
    expect(b.resolved.tool_access.mcp_skill).toBe(false)
    expect((await admin.handleGetGroupSessionConfig(target)).config.cli_access).toEqual({ schedule: 'none', config: 'read' })
    expect(admin.publishAdminEvent).toHaveBeenCalledWith('admin.session_config_updated', expect.objectContaining(target))
  })

  it('inherits CLI domains while allowing explicit tool and storage denial', async () => {
    await admin.handleUpdateGroupSessionConfig({ ...target, config: {
      template_id: 'group_scheduler', tool_access: { memory: false }, cli_access: { config: 'read' }, storage: null,
    } })
    const { resolved } = await admin.resolvePrincipalPermissions({ ...target, session_type: 'group' })
    expect(resolved.cli_access.schedule).toBe('write')
    expect(resolved.tool_access.memory).toBe(false)
    expect(resolved.storage).toBeNull()
  })

  it.each(['private', 'wrong-id', 'wrong-channel'])('rejects a mismatched target on the legacy path and on config writes; channel_id queries no longer verify session liveness: %s', async (mismatch) => {
    admin.resolveChannelSession.mockResolvedValue({
      id: mismatch === 'wrong-id' ? 'other' : target.session_id,
      channel_id: mismatch === 'wrong-channel' ? 'other' : target.channel_id,
      type: mismatch === 'private' ? 'private' : 'group',
    })
    // 2026-11-17~18 事故修复：带 channel_id 的权限查询不再验证 session 存活/身份/类型——
    // 验证对解析结果零贡献，channel 故障却会把权限系统整体打挂。带 channel_id 直接按入参本地解析。
    await expect(admin.resolvePrincipalPermissions({ ...target, session_type: 'group', sender_friend_id: 'master' })).resolves.toMatchObject({ sources: { session_template_id: 'group_default' } })
    // legacy 无 channel_id 遍历路径保留验证（mismatch 在某 channel 上抛 INVALID_PARAMS，
    // 遍历循环对非 NOT_FOUND 拒绝统一包装为 SERVICE_UNAVAILABLE 'Cannot prove unique session ownership'）
    await expect(admin.resolvePrincipalPermissions({ session_id: target.session_id, session_type: 'group', sender_friend_id: 'master' })).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_PARAMS|SERVICE_UNAVAILABLE/) })
    // 配置写路径的验证不变
    await expect(admin.handleUpdateGroupSessionConfig({ ...target, config: {} })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    expect(admin.saveData).not.toHaveBeenCalled()
  })

  it.each([{ cli_access: { schedule: true } }, { cli_access: { root: 'write' } }, { tool_access: { mcp_skill: 'true' } }, { template_id: 'missing' }])('rejects invalid permission input %j', async (config) => {
    await expect(admin.handleUpdateGroupSessionConfig({ ...target, config })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    expect(admin.saveData).not.toHaveBeenCalled()
  })

  it('ignores bare legacy keys in both group and private permission resolution', async () => {
    admin.sessionConfigs.set(target.session_id, { template_id: 'master_private', tool_access: createToolAccessConfig(true) })
    expect((await admin.resolvePrincipalPermissions({ ...target, session_type: 'group' })).resolved.tool_access.mcp_skill).toBe(false)
    admin.resolveChannelSession.mockResolvedValue({ ...target, id: target.session_id, type: 'private' })
    expect((await admin.resolvePrincipalPermissions({ ...target, session_type: 'private' })).sources.fallback).toBe('minimal')
  })

  it('legacy calls require a verified unique channel, including unavailable-channel failures', async () => {
    const input = { session_id: target.session_id, session_type: 'group' }
    await expect(admin.resolvePrincipalPermissions(input)).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    admin.resolveChannelSession.mockImplementation(async (channel_id: string, id: string) => {
      if (channel_id === 'channel-b') throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' })
      return { id, channel_id, type: 'group' }
    })
    expect((await admin.resolvePrincipalPermissions(input)).sources.session_template_id).toBe('group_default')
    admin.resolveChannelSession.mockImplementation(async () => { throw new Error('offline') })
    await expect(admin.resolvePrincipalPermissions(input)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })

  it('validates explicit Admin virtual sessions on legacy queries without calling a Channel module', async () => {
    const input = { channel_id: 'admin-web', session_id: 'admin-chat', session_type: 'private', sender_friend_id: 'master' }
    expect((await admin.resolvePrincipalPermissions(input)).sources.friend_template_id).toBe('master_private')
    expect(admin.resolveChannelSession).not.toHaveBeenCalled()
    // legacy 无 channel_id 路径保留 admin-web 虚拟 session 校验（type mismatch / unknown session）；
    // 带 channel_id 的请求不再做这些验证（2026-11-17~18 事故修复，见 mismatched target 用例）。
    await expect(admin.resolvePrincipalPermissions({ session_id: 'admin-chat', session_type: 'group' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(admin.resolvePrincipalPermissions({ session_id: 'unknown', session_type: 'private' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  })

  it('failed permission persistence cannot grant MCP or publish a success event', async () => {
    admin.atomicWriteFile.mockRejectedValue(new Error('disk full'))
    await expect(admin.handleUpdateGroupSessionConfig({ ...target, config: { tool_access: { mcp_skill: true } } })).rejects.toThrow('disk full')
    expect((await admin.resolvePrincipalPermissions({ ...target, session_type: 'group' })).resolved.tool_access.mcp_skill).toBe(false)
    expect(admin.publishAdminEvent).not.toHaveBeenCalled()
  })

  it('failed deletion preserves explicit denials and concurrent writes retain both groups', async () => {
    await admin.handleUpdateGroupSessionConfig({ ...target, config: { tool_access: { memory: false } } })
    admin.atomicWriteFile.mockRejectedValueOnce(new Error('disk full'))
    await expect(admin.handleDeleteGroupSessionConfig(target)).rejects.toThrow('disk full')
    expect((await admin.resolvePrincipalPermissions({ ...target, session_type: 'group' })).resolved.tool_access.memory).toBe(false)
    await Promise.all([
      admin.handleUpdateGroupSessionConfig({ ...target, config: { tool_access: { mcp_skill: true } } }),
      admin.handleUpdateGroupSessionConfig({ ...target, channel_id: 'channel-b', config: { cli_access: { schedule: 'write' } } }),
    ])
    expect((await admin.resolvePrincipalPermissions({ ...target, session_type: 'group' })).resolved.tool_access.mcp_skill).toBe(true)
    expect((await admin.resolvePrincipalPermissions({ ...target, channel_id: 'channel-b', session_type: 'group' })).resolved.cli_access.schedule).toBe('write')
  })

  it('does not expose a pending grant to readers', async () => {
    let finish!: () => void
    admin.atomicWriteFile.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const update = admin.handleUpdateGroupSessionConfig({ ...target, config: { tool_access: { mcp_skill: true } } })
    await vi.waitFor(() => expect(admin.atomicWriteFile).toHaveBeenCalledOnce())
    expect((await admin.resolvePrincipalPermissions({ ...target, session_type: 'group' })).resolved.tool_access.mcp_skill).toBe(false)
    finish()
    await update
    expect((await admin.resolvePrincipalPermissions({ ...target, session_type: 'group' })).resolved.tool_access.mcp_skill).toBe(true)
  })
})
