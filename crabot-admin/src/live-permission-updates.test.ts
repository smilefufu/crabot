import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminModule from './index.js'
import { CoreAgentConfigMutationCoordinator } from './core-agent-config-revision-store.js'
import { createCliAccessConfig, createToolAccessConfig } from './types.js'

describe('permission saves use the durable config notification path', () => {
  let directory: string, admin: any, coordinator: CoreAgentConfigMutationCoordinator
  const events: unknown[] = []
  const config = { tool_access: { ...createToolAccessConfig(false), shell: true, file_io: true }, cli_access: createCliAccessConfig('none'), storage: null, memory_scopes: [] }
  const friendConfig = () => ({ ...config, tool_access: { ...admin.buildResolvedFriendPermissions(admin.friends.get('original')).tool_access, shell: true, file_io: true } })
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-live-permissions-'))
    admin = new AdminModule({ moduleId: 'permission-fixture', moduleType: 'admin', version: 'test', protocolVersion: '0.1.0', port: 0 }, { data_dir: directory, web_port: 0 }) as any
    admin.dataLoaded = true
    admin.permissionTemplateManager.initSystemTemplates()
    admin.friends.set('original', { id: 'original', display_name: 'Original', permission: 'normal', permission_template_id: 'standard', channel_identities: [], created_at: 't', updated_at: 't' })
    admin.resolveChannelSession = async (channel_id: string, id: string) => ({ channel_id, id, type: 'group' })
    admin.publishAdminEvent = vi.fn()
    // Subject permission values are resolved separately, never published in the global model config.
    admin.readCoreAgentSemanticSnapshot = () => ({ fixture: 'unchanged-runtime-config' })
    events.length = 0
    coordinator = new CoreAgentConfigMutationCoordinator(directory, { readSemanticSnapshot: admin.readCoreAgentSemanticSnapshot,
      publishInvalidation: event => { events.push(event) } })
    admin.configMutationCoordinator = coordinator
    await coordinator.initialize()
  })
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }) })

  it('commits friend grants/reset, group grants/reset, templates and friend identity changes before notification', async () => {
    await admin.handleUpdateFriendPermission('original', friendConfig())
    expect(JSON.parse(await fs.readFile(admin.friendPermissionConfigsFilePath, 'utf8'))[0].config.tool_access.shell).toBe(true)
    await admin.handleUpdateFriendPermission('original', null)
    await admin.handleUpdateGroupSessionConfig({ channel_id: 'test', session_id: 'group', config: { tool_access: { shell: true } } })
    await admin.handleDeleteGroupSessionConfig({ channel_id: 'test', session_id: 'group' })
    const { template } = await admin.handleCreatePermissionTemplate({ ...config, name: 'Current' })
    await admin.handleUpdatePermissionTemplate({ template_id: template.id, tool_access: { ...template.tool_access, shell: false } })
    await admin.handleDeletePermissionTemplate({ template_id: template.id })
    await admin.handleUpdateFriend({ friend_id: 'original', permission: 'master' })
    expect(JSON.parse(await fs.readFile(admin.friendsFilePath, 'utf8'))[0].permission).toBe('master')
    expect(events).toEqual(Array.from({ length: 8 }, (_, index) => ({ config_revision: index + 2, domains: ['permissions'] })))
  })

  it.each(['friend', 'template'] as const)('failed %s persistence exposes neither an uncommitted grant nor a success hint', async kind => {
    const template = admin.permissionTemplateManager.create({ ...config, name: 'Denied', tool_access: createToolAccessConfig(false) })
    let fail!: (error: Error) => void
    vi.spyOn(admin, 'atomicWriteFile').mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    const save = kind === 'friend' ? admin.handleUpdateFriendPermission('original', friendConfig())
      : admin.handleUpdatePermissionTemplate({ template_id: template.id, tool_access: { ...template.tool_access, shell: true } })
    const rejected = expect(save).rejects.toThrow('disk full')
    await vi.waitFor(() => expect(fail).toBeTypeOf('function'))
    expect(kind === 'friend' ? admin.buildResolvedFriendPermissions(admin.friends.get('original')).tool_access.shell
      : admin.permissionTemplateManager.get(template.id).tool_access.shell).toBe(false)
    fail(new Error('disk full'))
    await rejected
    expect((await coordinator.current()).revision).toBe(1)
    expect(events).toEqual([])
    expect(kind === 'friend' ? admin.buildResolvedFriendPermissions(admin.friends.get('original')).tool_access.shell
      : admin.permissionTemplateManager.get(template.id).tool_access.shell).toBe(false)
  })

  it('retains and retries a failed notification after a successful source save', async () => {
    let attempts = 0
    const published: unknown[] = []
    coordinator = new CoreAgentConfigMutationCoordinator(directory, { readSemanticSnapshot: admin.readCoreAgentSemanticSnapshot,
      publishInvalidation: event => { if (++attempts === 1) throw new Error('transport unavailable'); published.push(event) } })
    admin.configMutationCoordinator = coordinator
    await expect(admin.handleUpdateFriendPermission('original', friendConfig())).rejects.toThrow('transport unavailable')
    expect(admin.buildResolvedFriendPermissions(admin.friends.get('original')).tool_access.shell).toBe(true)
    await coordinator.drainPendingInvalidation()
    expect(published).toEqual([{ config_revision: 2, domains: ['permissions'] }])
    expect((await coordinator.current()).revision).toBe(2)
  })
})
