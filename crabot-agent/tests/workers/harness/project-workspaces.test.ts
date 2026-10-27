import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { WorkspaceManager } from '../../../src/workers/harness/workspace-manager.js'
import { WorkspaceCatalog } from 'crabot-shared/dist/workspace-catalog.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-worker-'))); roots.push(root)
  const data = path.join(root, 'data'); await fs.mkdir(data, { mode: 0o700 })
  const manager = new WorkspaceManager(path.join(data, 'workspaces'), data)
  return { root, data, manager }
}
it('unknown projects share one default identity while retaining host-verified task file isolation', async () => {
  const f = await fixture(), a = await f.manager.resolve('a'), b = await f.manager.resolve('b')
  expect(a.workspace_id).toBe('default'); expect(b.workspace_id).toBe('default')
  expect(a.root).toBe(path.join(f.data, 'workspaces/default/tasks/a'))
  expect(b.root).not.toBe(a.root); expect(a.runtime_root).toBe(path.join(f.data, 'agent/worker-runtime/a'))
  expect(await f.manager.fileScope('a', a.root)()).toBe(a.root)
  expect(await f.manager.fileScope('a', b.root)()).toBeUndefined()
})
it('multiple executors reuse the canonical project and separate private configuration without changing project files', async () => {
  const f = await fixture(), project = path.join(f.root, 'project'); await fs.mkdir(project)
  await fs.writeFile(path.join(project, '.mcp.json'), 'original user MCP')
  const a = await f.manager.resolve('a', project), b = await f.manager.resolve('b', project)
  expect(a.workspace_id).toBeTruthy(); expect(a.workspace_id).toBe(b.workspace_id); expect(a.workspace_id).not.toBe('default')
  expect(a.root).toBe(b.root); expect(a.runtime_root).not.toBe(b.runtime_root)
  expect(await f.manager.fileScope('a', project)()).toBeUndefined()
  expect(await fs.readFile(path.join(project, '.mcp.json'), 'utf8')).toBe('original user MCP')
  const continued = await f.manager.resolveExisting('a', project, a.workspace_id)
  expect(continued).toEqual(a)
  await fs.rm(project, { recursive: true })
  await expect(f.manager.resolveExisting('a', project, a.workspace_id)).rejects.toThrow()
  await expect(fs.stat(project)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('legacy cwd remains in place and never becomes an inferred project or a fresh private native profile', async () => {
  const f = await fixture(), legacy = path.join(f.data, 'workspaces/old')
  await fs.mkdir(legacy, { recursive: true }); await fs.writeFile(path.join(legacy, 'result.txt'), 'old result')
  expect(await f.manager.resolveExisting('old', legacy)).toEqual({ root: legacy })
  expect(await f.manager.fileScope('old', legacy)()).toBe(legacy)
  expect(await fs.readFile(path.join(legacy, 'result.txt'), 'utf8')).toBe('old result')
  await expect(f.manager.resolve('other', legacy)).rejects.toThrow()
})
it('a registered project under the managed project collection is reusable but the collection is never a task root', async () => {
  const f = await fixture(), catalog = new WorkspaceCatalog({ dataRoot: f.data, files: require('../../../../scripts/lib/process-identity.cjs') })
  const { workspace } = await catalog.createProject({ workspace_id: '12345678-1234-4123-8123-123456789abc', name: '项目' })
  expect((await f.manager.resolve('a', workspace.root)).workspace_id).toBe(workspace.workspace_id)
  await expect(f.manager.resolve('b', path.dirname(workspace.root))).rejects.toThrow()
})

it('missing private profiles and conflicting project bindings never become empty native sessions', async () => {
  const f = await fixture(), project = path.join(f.root, 'project'), other = path.join(f.root, 'other')
  await fs.mkdir(project); await fs.mkdir(other)
  const worker = await f.manager.resolve('a', project)
  await expect(f.manager.resolveExisting('a', other, worker.workspace_id)).rejects.toThrow('binding')
  await fs.rm(worker.runtime_root!, { recursive: true })
  await expect(f.manager.resolveExisting('a', project, worker.workspace_id)).rejects.toThrow('private native runtime is missing')
  await expect(fs.stat(worker.runtime_root!)).rejects.toMatchObject({ code: 'ENOENT' })
  for (const id of ['default', 'projects']) await expect(f.manager.resolve(id)).rejects.toThrow('invalid task identity')
})
