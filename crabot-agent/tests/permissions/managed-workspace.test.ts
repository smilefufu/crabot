import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceManager } from '../../src/workers/harness/workspace-manager.js'
import { checkFileAccess } from '../../src/permissions/tool-authorization.js'
import { UnifiedAgent } from '../../src/unified-agent.js'
import { BUILTIN_WORKER_PERMISSIONS } from '../../src/workers/builtin/runtime.js'

describe('host-verified managed task files', () => {
  let root: string, workspace: string, workspaces: WorkspaceManager
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-files-'))
    workspaces = new WorkspaceManager(path.join(root, 'workspaces'))
    workspace = (await workspaces.resolve('owner')).root
  })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const principal = () => ({ ...BUILTIN_WORKER_PERMISSIONS, storage: null })
  it('executes actual Write/Read in its default root with no extra range', async () => {
    const agent = Object.create(UnifiedAgent.prototype) as any
    Object.assign(agent, { config: { moduleId: 'fixture' }, agentConfig: { skills: [{ id: 'tmp-page', name: 'tmp-page', description: 'fixture', skill_dir: root }], subagents: [] },
      agentHandler: { createBuiltinBgToolOptions: () => undefined }, mcpConnector: { getAllTools: () => [] }, knownSecrets: [] })
    const tools = agent.buildBuiltinWorkerTools({ worker_id: 'owner', workspace: { root: workspace },
      principal_permissions: principal(), managed_workspace: workspaces.fileScope('owner', workspace) })
    const file = path.join(workspace, 'result.txt')
    expect(await tools.find((t: any) => t.name === 'Write')?.call({ file_path: file, content: 'task result' }, {})).toMatchObject({ isError: false })
    expect(await fs.readFile(file, 'utf8')).toBe('task result')
    expect((await tools.find((t: any) => t.name === 'Read').call({ file_path: file }, {})).output).toContain('task result')
    expect(tools.some((t: any) => t.category === 'messaging' || t.category === 'memory')).toBe(false)
  })
  it('keeps file_io as the total switch and never derives ownership from cwd', async () => {
    const file = path.join(workspace, 'new.txt'), scope = workspaces.fileScope('owner', workspace)
    expect((await checkFileAccess(principal(), file, workspace, true)).allowed).toBe(false)
    const disabled = principal(); disabled.tool_access = { ...disabled.tool_access, file_io: false }
    expect((await checkFileAccess(disabled, file, workspace, true, scope)).allowed).toBe(false)
    expect((await checkFileAccess(undefined, file, workspace, true, scope)).allowed).toBe(false)
  })
  it('combines own default read/write with readonly extra storage without widening either root', async () => {
    const extra = path.join(root, 'extra'); await fs.mkdir(extra)
    const p = { ...principal(), storage: { workspace_path: extra, access: 'read' as const } }, scope = workspaces.fileScope('owner', workspace)
    for (const write of [false, true]) expect((await checkFileAccess(p, path.join(workspace, 'new/sub.txt'), '/', write, scope)).allowed).toBe(true)
    expect((await checkFileAccess(p, extra, '/', false, scope)).allowed).toBe(true)
    expect((await checkFileAccess(p, extra, '/', true, scope)).allowed).toBe(false)
    for (const target of [root, path.dirname(workspace), workspace + '-other', path.join(path.dirname(workspace), 'other/new')]) {
      expect((await checkFileAccess(p, target, '/', false, scope)).allowed).toBe(false)
    }
  })
  it('resolves new paths and symlinks, and does not follow a replaced task root', async () => {
    const scope = workspaces.fileScope('owner', workspace), outside = path.join(root, 'outside')
    await fs.mkdir(outside); await fs.symlink(outside, path.join(workspace, 'escape'))
    expect((await checkFileAccess(principal(), path.join(workspace, 'escape/new.txt'), '/', true, scope)).allowed).toBe(false)
    await fs.rm(workspace, { recursive: true }); await fs.symlink(outside, workspace)
    expect((await checkFileAccess(principal(), path.join(workspace, 'new.txt'), '/', true, scope)).allowed).toBe(false)
    await expect(workspaces.resolve('owner')).rejects.toThrow()
    expect(await fs.readdir(outside)).toEqual([])
  })
  it.each(['../escape', '.', '..', '/absolute', 'bad\0id'])('rejects a non-host task identifier %s', async id => {
    await expect(workspaces.resolve(id)).rejects.toThrow('invalid task identity')
  })
  it('accepts a configured root alias while retaining the real task boundary', async () => {
    const alias = path.join(root, 'alias'); await fs.symlink(path.join(root, 'workspaces'), alias)
    const aliased = new WorkspaceManager(alias), own = (await aliased.resolve('aliased-owner')).root
    expect((await checkFileAccess(principal(), path.join(own, 'new.txt'), '/', true, aliased.fileScope('aliased-owner', own))).allowed).toBe(true)
    expect((await checkFileAccess(principal(), workspace, '/', false, aliased.fileScope('aliased-owner', own))).allowed).toBe(false)
  })
  it('does not turn an external cwd or another task into a default grant', async () => {
    const other = (await workspaces.resolve('other')).root
    expect((await checkFileAccess(principal(), other, '/', false, workspaces.fileScope('owner', other))).allowed).toBe(false)
    expect((await checkFileAccess(principal(), root, '/', true, workspaces.fileScope('owner', root))).allowed).toBe(false)
  })
})
