import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { allowed, checkFileAccess, denied } from '../../src/permissions/tool-authorization.js'
import { RequestPermissionGate } from '../../src/manager/request-permission-gate.js'
import type { ConversationRequestSource, RequestPermissionSource, ResolveRequestPermissionSourcesResult } from '../../src/manager/request-permission-sources.js'

const origin: ConversationRequestSource = { source_id: 'fixture', channel_id: 'channel', session_id: 'group', session_type: 'group', platform_message_id: 'message', platform_user_id: 'platform-a', sender_friend_id: 'friend-a' }
describe('Request operation checks keep complete sources and fixed ceilings', () => {
  let directory: string, group: RequestPermissionSource, personal: RequestPermissionSource
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-operation-'))
    await fs.mkdir(path.join(directory, 'read-a')); await fs.mkdir(path.join(directory, 'write-b'))
    function source(kind: 'group' | 'friend', subject: string, scope: string, access: 'read' | 'readwrite'): RequestPermissionSource {
      return { kind, subject_id: subject, is_master: false, resolved: { tool_access: { memory: false, messaging: false, task: false, mcp_skill: false, file_io: true, browser: false, shell: false, remote_exec: false, desktop: false }, cli_access: { provider: 'none', agent: 'none', mcp: 'none', skill: 'none', schedule: 'none', channel: 'none', friend: 'none', permission: 'none', config: 'none', undo: 'none' }, storage: { workspace_path: path.join(directory, scope), access }, memory_scopes: [] } }
    }
    group = source('group', 'channel::group', 'read-a', 'read'); personal = source('friend', 'friend-a', 'write-b', 'readwrite')
  })
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }) })
  function setup() {
    const ceiling: ResolveRequestPermissionSourcesResult = { group: structuredClone(group), friend: structuredClone(personal) }
    const current = vi.fn(async (kind: 'group' | 'friend') => kind === 'group' ? group : personal)
    return { gate: new RequestPermissionGate(origin, ceiling, current), current, ceiling }
  }
  const file = (value: string, write: boolean) => (source: RequestPermissionSource) => checkFileAccess(source.resolved, value, '/', write)
  it('allows read A and write B but refuses the manufactured write A combination', async () => {
    const { gate } = setup()
    expect(await gate.authorize(file(path.join(directory, 'read-a/item'), false))).toMatchObject({ allowed: true, source: { kind: 'group' } })
    expect(await gate.authorize(file(path.join(directory, 'write-b/item'), true))).toMatchObject({ allowed: true, source: { kind: 'friend', subject_id: 'friend-a' } })
    expect(await gate.authorize(file(path.join(directory, 'read-a/item'), true))).toMatchObject({ allowed: false })
  })
  it('prefers the public source without consulting personal permissions when it already permits the whole action', async () => {
    const { gate, current } = setup()
    expect((await gate.authorize(file(path.join(directory, 'read-a/item'), false))).allowed).toBe(true)
    expect(current.mock.calls.map(call => call[0])).toEqual(['group'])
  })
  it('checks current scope and the creation scope independently without expanding either one', async () => {
    const { gate } = setup()
    personal.resolved.storage = { workspace_path: directory, access: 'readwrite' }
    expect((await gate.authorize(file(path.join(directory, 'read-a/item'), true))).allowed).toBe(false)
    personal.resolved.storage = { workspace_path: path.join(directory, 'read-a'), access: 'readwrite' }
    expect((await gate.authorize(file(path.join(directory, 'write-b/item'), true))).allowed).toBe(false)
  })
  it('newly granted categories or changed caller copies cannot enlarge a previously captured ceiling', async () => {
    const { gate, ceiling } = setup()
    ceiling.friend!.resolved.tool_access.shell = true
    personal.resolved.tool_access.shell = true
    expect((await gate.authorize(async source => source.resolved.tool_access.shell ? allowed : denied('PERMISSION_DENIED', 'shell'))).allowed).toBe(false)
  })
  it('revalidates personal authority on every call and rejects a different subject with identical permissions', async () => {
    const { gate } = setup(); const action = file(path.join(directory, 'write-b/item'), true)
    expect((await gate.authorize(action)).allowed).toBe(true)
    personal.subject_id = 'friend-b'
    expect((await gate.authorize(action)).allowed).toBe(false)
    personal.subject_id = 'friend-a'; personal.resolved.tool_access.file_io = false
    expect((await gate.authorize(action)).allowed).toBe(false)
  })
  it('a stranger can use public authority but cannot acquire the current nearby Master source', async () => {
    personal.is_master = true
    const gate = new RequestPermissionGate({ ...origin, sender_friend_id: null }, { group, friend: null }, async kind => kind === 'group' ? group : personal)
    expect((await gate.authorize(file(path.join(directory, 'read-a/item'), false))).allowed).toBe(true)
    expect((await gate.authorize(async source => source.is_master ? allowed : denied('PERMISSION_DENIED', 'Master'))).allowed).toBe(false)
  })
  it('Master-only actions require both the original and current real Master source', async () => {
    personal.is_master = true
    const { gate } = setup(); const action = async (source: RequestPermissionSource) => source.is_master ? allowed : denied('PERMISSION_DENIED', 'Master')
    expect((await gate.authorize(action)).allowed).toBe(true)
    personal.is_master = false
    expect((await gate.authorize(action)).allowed).toBe(false)
  })
  it('unavailable or malformed current authority never falls back to a wider snapshot', async () => {
    const ceiling = { group, friend: personal }
    const gate = new RequestPermissionGate(origin, ceiling, async () => { throw new Error('service unavailable') })
    expect((await gate.authorize(async () => allowed)).allowed).toBe(false)
    const wrong = new RequestPermissionGate(origin, ceiling, async () => ({ ...group, subject_id: 'other-group' }))
    expect((await wrong.authorize(async () => allowed)).allowed).toBe(false)
  })
  it('reports safe directory denial without leaking other source roots or claiming database failure', async () => {
    const { gate } = setup()
    const result = await gate.authorize(file(path.join(directory, 'outside/item'), true))
    expect(result).toMatchObject({ allowed: false, reason: expect.stringContaining('目录范围') })
    if (!result.allowed) { expect(result.reason).not.toContain(directory); expect(result.reason).not.toContain('数据库') }
  })

  it('does not treat words inside an unverified path error as another permission category', async () => {
    const { gate } = setup()
    const result = await gate.authorize(async () => denied('PERMISSION_DENIED', '无法核实文件范围：/private/文件范围只读'))
    expect(result).toMatchObject({ allowed: false, reason: expect.stringContaining('文件范围无法核验') })
    if (!result.allowed) expect(result.reason).not.toContain('目录范围只读')
  })

})
