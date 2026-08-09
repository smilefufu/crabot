import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { WorkerContextStore } from '../../../src/workers/harness/context-store.js'
import type { ResolvedPermissions } from '../../../src/types.js'

const permissions: ResolvedPermissions = {
  tool_access: { memory: true, messaging: false, task: false, mcp_skill: true, file_io: true, browser: true, shell: true, remote_exec: false, desktop: false },
  cli_access: { provider: 'none', agent: 'none', mcp: 'none', skill: 'none', schedule: 'none', channel: 'none', friend: 'none', permission: 'none', config: 'none', undo: 'none' },
  storage: null,
  memory_scopes: ['friend-a'],
}

describe('WorkerContextStore', () => {
  let root: string
  beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'worker-context-')) })
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })

  it('atomically round-trips only the principal permission snapshot', async () => {
    const store = new WorkerContextStore(root)
    await store.write('w-1', { principal_permissions: permissions })
    expect(await store.read('w-1')).toEqual({ principal_permissions: permissions })
    expect(JSON.parse(await fs.readFile(join(root, 'w-1', 'context.json'), 'utf8'))).toEqual({ principal_permissions: permissions })
  })

  it('distinguishes legacy ENOENT from a newly written empty context', async () => {
    const store = new WorkerContextStore(root)
    expect(await store.read('legacy')).toBeUndefined()
    await store.write('w-1', {})
    expect(await store.read('w-1')).toEqual({})
  })

  it('写入历史部分权限时按最严默认补齐，落盘后仍通过严格读取', async () => {
    const store = new WorkerContextStore(root)
    const partial = {
      principal_permissions: {
        tool_access: { mcp_skill: true },
        cli_access: { mcp: 'read' },
        storage: null,
        memory_scopes: ['legacy'],
      },
    } as unknown as Parameters<WorkerContextStore['write']>[1]

    const normalized = await store.write('w-partial', partial)
    expect(normalized.principal_permissions).toMatchObject({
      tool_access: { mcp_skill: true, desktop: false, shell: false },
      cli_access: { mcp: 'read', undo: 'none', provider: 'none' },
    })
    expect(await store.read('w-partial')).toEqual(normalized)
  })

  it('写入时仍拒绝未知权限字段，不把连接信息带入 context', async () => {
    const store = new WorkerContextStore(root)
    const invalid = {
      principal_permissions: {
        ...permissions,
        headers: { Authorization: 'secret' },
      },
    } as unknown as Parameters<WorkerContextStore['write']>[1]
    await expect(store.write('w-invalid', invalid)).rejects.toThrow(/invalid principal_permissions/)
  })

  it.each([
    '{',
    '[]',
    '{"unexpected":true}',
    '{"principal_permissions":{"tool_access":{}}}',
    '{"principal_permissions":{"tool_access":{"memory":true,"messaging":false,"task":false,"mcp_skill":true,"file_io":true,"browser":true,"shell":true,"remote_exec":false,"desktop":false},"cli_access":{"provider":"none","agent":"none","mcp":"none","skill":"none","schedule":"none","channel":"none","friend":"none","permission":"none","config":"none","undo":"none"},"storage":null,"memory_scopes":[],"headers":{"Authorization":"secret"}}}',
  ])('fails loud for invalid persisted context: %s', async (raw) => {
    const store = new WorkerContextStore(root)
    await fs.mkdir(join(root, 'w-1'), { recursive: true })
    await fs.writeFile(join(root, 'w-1', 'context.json'), raw)
    await expect(store.read('w-1')).rejects.toThrow(/WorkerContextStore/)
  })

  it('cleans its temporary file when atomic write fails', async () => {
    const store = new WorkerContextStore(root)
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk error'))
    await expect(store.write('w-1', {})).rejects.toThrow('disk error')
    expect(rename).toHaveBeenCalledOnce()
    expect((await fs.readdir(join(root, 'w-1'))).filter((name) => name.includes('.tmp-'))).toEqual([])
  })
})
