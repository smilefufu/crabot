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
