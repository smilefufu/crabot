import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminModule from '../../../crabot-admin/src/index.js'
import { PermissionTemplateManager } from '../../../crabot-admin/src/permission-template-manager.js'
import { groupSessionConfigKey } from '../../../crabot-admin/src/group-session-config.js'
import { createToolAccessConfig } from '../../../crabot-admin/src/types.js'
import { UnifiedAgent } from '../../src/unified-agent.js'
import type { Friend, ResolvedPermissions, UnifiedAgentConfig } from '../../src/types.js'
import type { ManagerStack } from '../../src/manager/bootstrap.js'
import type { ManagerRegistryDeps, ScheduleIdentity } from '../../src/manager/registry.js'
import type { HumanPrincipal } from '../../src/manager/principal.js'
import { createManagerToolFaceState, NORMAL_MANAGER_CORE_NAMES } from '../../src/manager/tools/tool-catalog.js'

const target = { channel_id: 'test-channel', session_id: 'session-a', type: 'private' as const }
const key = 'test-channel::session-a'
const mcpName = 'mcp__archive__lookup'
const desktopName = 'mcp__computer-use__capture'

function friend(id: string, permission: Friend['permission'] = 'normal'): Friend {
  return { id, permission, display_name: id, channel_identities: [], permission_template_id: 'standard',
    created_at: '2026-09-12T00:00:00Z', updated_at: '2026-09-12T00:00:00Z' }
}

describe('Manager MCP production authorization wiring', () => {
  let directory: string
  let admin: any
  let agent: any
  let deps: ManagerRegistryDeps
  let execute: ReturnType<typeof vi.fn>
  let rpc: ReturnType<typeof vi.fn>
  let stack: ManagerStack

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'manager-mcp-auth-'))
    vi.stubEnv('DATA_DIR', directory)
    vi.stubEnv('CRABOT_AGENT_DATA_DIR', '')
    vi.stubEnv('CRABOT_MANAGER_MCP_ENABLED', '1')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const templates = new PermissionTemplateManager()
    templates.initSystemTemplates()
    // Keep both production resolvers; replace only Channel, RPC and MCP I/O.
    admin = Object.create(AdminModule.prototype)
    Object.assign(admin, {
      permissionTemplateManager: templates,
      sessionConfigs: new Map(),
      friends: new Map([['creator', friend('creator')], ['master-friend', friend('master-friend', 'master')]]),
      friendPermissionConfigs: new Map(),
      resolveChannelSession: vi.fn(async (channel_id, id) => ({ channel_id, id, type: 'private' })),
    })
    agent = new UnifiedAgent({
      module_id: 'manager-mcp-test', module_type: 'agent', version: '0.0.0-test', protocol_version: '1.0', port: 19999,
      orchestration: {
        front_context_recent_messages_window_hours: 24, front_context_recent_messages_max_cap: 50,
        front_context_short_term_memory_window_hours: 24, front_context_short_term_memory_max_cap: 20,
        worker_recent_messages_window_hours: 24, worker_recent_messages_max_cap: 50,
        worker_short_term_memory_window_hours: 24, worker_short_term_memory_max_cap: 20,
        worker_long_term_memory_limit: 10, front_agent_timeout: 60, session_state_ttl: 3600,
        worker_config_refresh_interval: 300, front_agent_queue_max_length: 10, front_agent_queue_timeout: 60,
      },
      agent_config: { instance_id: 'mcp-test', roles: [], system_prompt: 'test', model_config: {} },
    } as UnifiedAgentConfig)
    agent.adminPort = 1
    agent.memoryPort = 2
    rpc = vi.spyOn(agent.rpcClient, 'call').mockImplementation(async (_port, method, params: any) => {
      if (method === 'resolve_principal_permissions') return admin.resolvePrincipalPermissions(params)
      if (method === 'get_friend') return { friend: admin.friends.get(params.friend_id) ?? null }
      if (method === 'get_scene_profile') return { profile: null }
      if (method === 'get_group_session_config') return { config: null }
      throw new Error(`Unexpected RPC: ${method}`)
    })
    execute = vi.fn(async () => ({ output: 'executed', isError: false }))
    vi.spyOn(agent.mcpConnector, 'getAllTools').mockReturnValue([
      { name: mcpName, category: 'mcp_skill', description: 'Search archive', inputSchema: { type: 'object', properties: {} }, isReadOnly: false, call: execute },
      { name: desktopName, category: 'desktop', description: 'Capture desktop', inputSchema: { type: 'object', properties: {} }, isReadOnly: false, call: execute },
    ])
    stack = agent.managerStack
    await stack.principals.init()
    deps = (stack.registry as unknown as { deps: ManagerRegistryDeps }).deps
  })

  afterEach(async () => {
    await agent?.traceCursorStoreInstance?.flush?.()
    await agent?.nativeTraceCopyStoreInstance?.flush?.()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await fs.rm(directory, { recursive: true, force: true })
  })

  function grantPrivate(mcp = true): void {
    admin.friendPermissionConfigs.set('creator', {
      tool_access: { ...createToolAccessConfig(false), memory: true, messaging: true, task: true, mcp_skill: mcp },
      cli_access: { schedule: 'write' }, storage: null, memory_scopes: [], updated_at: '2026-09-12T00:00:00Z',
    })
  }

  function groupTarget(mcp = false): ScheduleIdentity['targetSession'] {
    admin.resolveChannelSession.mockResolvedValue({ channel_id: target.channel_id, id: target.session_id, type: 'group' })
    admin.sessionConfigs.set(groupSessionConfigKey(target.channel_id, target.session_id), {
      template_id: 'group_scheduler', tool_access: { mcp_skill: mcp, desktop: true }, updated_at: '2026-09-12T00:00:00Z',
    })
    return { ...target, type: 'group' }
  }

  function face(permissions?: ResolvedPermissions, identity?: ScheduleIdentity, human?: HumanPrincipal, mode: 'full' | 'shadow' | 'progressive' = 'progressive') {
    const state = createManagerToolFaceState(mode)
    const tools = () => deps.toolFace(key, false, identity, human, permissions, undefined, undefined, state)
    const search = async (name: string) => {
      const result = await tools().find(tool => tool.name === 'search_tools')!.call({ query: name, limit: 1 }, {} as never)
      return JSON.parse(result.output as string)
    }
    const expectHidden = async (name: string) => {
      expect(JSON.stringify(await search(name))).not.toContain(name)
      expect(tools().some(tool => tool.name === name)).toBe(false)
      expect(state.catalog!.missingToolOutput(name)).toBe('TOOL_UNAVAILABLE')
    }
    return { tools, search, state, expectHidden }
  }

  async function scheduled(identity: ScheduleIdentity) {
    const permissions = await deps.onScheduleWake!({ key, ...identity })
    return face(permissions ?? undefined, identity)
  }

  it('Schedule write does not grant MCP; adding MCP permission enables direct execution next turn', async () => {
    grantPrivate(false)
    const identity = { targetSession: target, creatorFriendId: 'creator' }
    await (await scheduled(identity)).expectHidden(mcpName)
    grantPrivate()
    const episode = await scheduled(identity)
    expect(episode.tools().map(tool => tool.name)).toEqual(NORMAL_MANAGER_CORE_NAMES)
    expect(await episode.search(mcpName)).toMatchObject({ status: 'loaded', loaded: [mcpName] })
    const tool = episode.tools().find(tool => tool.name === mcpName)!
    expect(tool.isReadOnly).toBe(false)
    expect(await tool.call({}, {} as never)).toMatchObject({ isError: false })
    expect(execute).toHaveBeenCalledOnce()
    expect(rpc).toHaveBeenLastCalledWith(1, 'resolve_principal_permissions', {
      sender_friend_id: 'creator', channel_id: target.channel_id, session_id: target.session_id, session_type: 'private',
    }, 'manager-mcp-test')
  })

  it.each(['revoke', 'delete', 'offline'])('loaded private MCP fails closed after %s without repeating a side effect', async (change) => {
    grantPrivate()
    const identity = { targetSession: target, creatorFriendId: 'creator' }
    const episode = await scheduled(identity)
    await episode.search(mcpName)
    const tool = episode.tools().find(tool => tool.name === mcpName)!
    if (change === 'revoke') grantPrivate(false)
    if (change === 'delete') admin.friends.delete('creator')
    if (change === 'offline') admin.resolveChannelSession.mockRejectedValue(new Error('offline'))
    expect(await tool.call({}, {} as never)).toMatchObject({ isError: true, output: 'TOOL_CATALOG_CHANGED' })
    expect(execute).not.toHaveBeenCalled()
    if (change === 'revoke') await (await scheduled(identity)).expectHidden(mcpName)
    if (change === 'delete') await expect(scheduled(identity)).rejects.toMatchObject({ code: 'AGENT_SCHEDULE_AUTH_REVOKED' })
  })

  it('Master creator grants its current private MCP categories without granting Master-only Manager tools', async () => {
    const episode = await scheduled({ targetSession: target, creatorFriendId: 'master-friend' })
    for (const name of [mcpName, desktopName]) {
      expect((await episode.search(name)).loaded).toContain(name)
      expect(await episode.tools().find(tool => tool.name === name)!.call({}, {} as never)).toMatchObject({ isError: false })
    }
    expect(episode.tools().some(tool => tool.name === 'list_all_workers')).toBe(false)
    expect(stack.principals.currentMasterAuthorization(key)).toBeUndefined()
  })

  it('group Schedule uses only group permission; creator deletion does not invalidate it', async () => {
    const identity = { targetSession: groupTarget(), creatorFriendId: 'master-friend' }
    await (await scheduled(identity)).expectHidden(mcpName)
    groupTarget(true)
    admin.friends.delete('master-friend')
    const episode = await scheduled(identity)
    expect((await episode.search(mcpName)).loaded).toContain(mcpName)
    await episode.expectHidden(desktopName)
    expect(await episode.tools().find(tool => tool.name === mcpName)!.call({}, {} as never)).toMatchObject({ isError: false })
    const resolutions = rpc.mock.calls.filter(([, method]) => method === 'resolve_principal_permissions')
    expect(resolutions.every(([, , params]) => params.sender_friend_id === undefined && params.session_type === 'group')).toBe(true)
  })

  it('human and non-human wakes refresh current group authorization without stale MCP grants', async () => {
    groupTarget(true)
    const human: HumanPrincipal = { friend: admin.friends.get('master-friend'), sessionType: 'group' }
    const permissions = await deps.onHumanWake!(key, human)
    expect((await face(permissions as ResolvedPermissions, undefined, human).search(mcpName)).loaded).toContain(mcpName)
    groupTarget(false)
    await deps.beforeWake!(key, undefined)
    await face().expectHidden(mcpName)
    groupTarget(true)
    await deps.beforeWake!(key, undefined)
    expect((await face().search(mcpName)).loaded).toContain(mcpName)
    admin.resolveChannelSession.mockRejectedValue(new Error('offline'))
    await deps.beforeWake!(key, undefined)
    await face().expectHidden(mcpName)
  })

  it('human Master private access is revalidated after downgrade and unknown principals have no MCP', async () => {
    await face().expectHidden(mcpName)
    const human: HumanPrincipal = { friend: admin.friends.get('master-friend'), sessionType: 'private' }
    const permissions = await deps.onHumanWake!(key, human)
    const episode = face(permissions as ResolvedPermissions, undefined, human)
    expect((await episode.search(desktopName)).loaded).toContain(desktopName)
    const tool = episode.tools().find(tool => tool.name === desktopName)!
    expect(await tool.call({}, {} as never)).toMatchObject({ isError: false })
    admin.friends.set('master-friend', friend('master-friend'))
    await deps.beforeWake!(key, undefined)
    await face().expectHidden(desktopName)
    expect(await tool.call({}, {} as never)).toMatchObject({ isError: true, output: 'TOOL_CATALOG_CHANGED' })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('default groups and trusted builtin profiles cannot discover external MCP', async () => {
    groupTarget()
    admin.sessionConfigs.clear()
    const human: HumanPrincipal = { friend: admin.friends.get('master-friend'), sessionType: 'group' }
    const permissions = await deps.onHumanWake!(key, human)
    const group = face(permissions as ResolvedPermissions, undefined, human)
    await group.expectHidden(mcpName)
    await group.expectHidden(desktopName)
    await (await scheduled({ targetSession: target, isBuiltin: true, taskType: 'daily_reflection' })).expectHidden(mcpName)
    const graph = await scheduled({ targetSession: target, isBuiltin: true, scheduleId: 'memory-graph-rebuild' })
    expect(graph.tools().map(tool => tool.name)).toEqual([
      'mcp__crab-memory__list_entries', 'mcp__crab-memory__search_long_term', 'mcp__crab-memory__set_memory_links',
    ])
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(['full', 'shadow'] as const)('%s never exposes or executes external MCP even when its switch is on', async (mode) => {
    const permissions = await deps.onScheduleWake!({ key, targetSession: target, creatorFriendId: 'master-friend' })
    const episode = face(permissions!, { targetSession: target, creatorFriendId: 'master-friend' }, undefined, mode)
    await episode.expectHidden(mcpName)
    expect(execute).not.toHaveBeenCalled()
  })

  it('the MCP kill switch blocks already loaded calls and excludes MCP from new episodes', async () => {
    grantPrivate()
    const identity = { targetSession: target, creatorFriendId: 'creator' }
    const episode = await scheduled(identity)
    await episode.search(mcpName)
    const loaded = episode.tools().find(tool => tool.name === mcpName)!
    vi.stubEnv('CRABOT_MANAGER_MCP_ENABLED', '0')
    expect(await loaded.call({}, {} as never)).toMatchObject({ isError: true })
    await (await scheduled(identity)).expectHidden(mcpName)
    expect(execute).not.toHaveBeenCalled()
  })
})
