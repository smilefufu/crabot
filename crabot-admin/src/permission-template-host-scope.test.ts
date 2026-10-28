import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PermissionTemplateManager } from './permission-template-manager.js'
import { createToolAccessConfig } from './types.js'
import { executionAdmission } from '../../crabot-agent/src/workers/execution-policy.js'
import { authorizeTool, fileAuthorization } from '../../crabot-agent/src/permissions/tool-authorization.js'
import { createReadTool } from '../../crabot-agent/src/engine/tools/read-tool.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
function master() {
  const manager = new PermissionTemplateManager(); manager.initSystemTemplates()
  return manager.resolvePermissions('master_private', null)!
}

it('the built-in administrator is admitted with its actual default template on Windows', () => {
  expect(executionAdmission('codex', master(), 'win32')).toEqual({ status: 'allowed', reasons: [] })
})

it.skipIf(process.platform !== 'win32')('the actual built-in administrator reads its own project on both Windows drives', async () => {
  const home = await fs.mkdtemp(path.join(os.homedir(), 'crabot-master-scope-')); roots.push(home)
  const repository = await fs.mkdtemp(path.join(process.cwd(), '.master-scope-')); roots.push(repository)
  expect(path.parse(home).root.toLowerCase()).not.toBe(path.parse(repository).root.toLowerCase())
  for (const root of [home, repository]) {
    const file = path.join(root, 'project.txt'); await fs.writeFile(file, 'owned project content')
    const permissions = master()
    const read = authorizeTool(createReadTool(() => process.cwd()), fileAuthorization('worker', () => permissions, () => process.cwd(), 'file_path', false))
    const result = await read.call({ file_path: file }, {})
    expect(result.isError, result.output).toBe(false)
    expect(result.output).toContain('owned project content')
  }
}, 20000)

it('custom explicit directory restrictions and new ordinary templates retain their original meanings', () => {
  const manager = new PermissionTemplateManager(); manager.initSystemTemplates()
  const { task, browser, remote_exec, ...tool_access } = createToolAccessConfig(false)
  const existing = manager.create({ name: 'restricted', tool_access, storage: { workspace_path: 'C:\\project', access: 'read' } })
  expect(manager.resolvePermissions(existing.id, null)?.storage).toEqual({ workspace_path: 'C:\\project', access: 'read' })
  expect(manager.resolvePermissions('standard', null)?.storage).toBeNull()
  expect(manager.resolvePermissions('group_default', null)?.storage).toBeNull()
})

it('startup refreshes the old built-in cache without changing custom directory restrictions', () => {
  const manager = new PermissionTemplateManager(); manager.initSystemTemplates()
  const previous = manager.toArray().map(template => template.id === 'master_private'
    ? { ...template, storage: { workspace_path: '/', access: 'readwrite' as const } }
    : template)
  const { task, browser, remote_exec, ...tool_access } = createToolAccessConfig(false)
  const custom = manager.create({ name: 'private project', tool_access, storage: { workspace_path: 'C:\\project', access: 'read' } })
  manager.loadFromArray([...previous, custom]); manager.initSystemTemplates()
  expect(manager.resolvePermissions('master_private', null)?.storage).toEqual({ scope: 'all', access: 'readwrite' })
  expect(manager.get(custom.id)).toEqual(custom)
})

it.skipIf(process.platform !== 'win32')('the already supported explicit all scope reads the same two native Windows drives', async () => {
  const home = await fs.mkdtemp(path.join(os.homedir(), 'crabot-master-all-control-')); roots.push(home)
  const repository = await fs.mkdtemp(path.join(process.cwd(), '.master-all-control-')); roots.push(repository)
  expect(path.parse(home).root.toLowerCase()).not.toBe(path.parse(repository).root.toLowerCase())
  for (const root of [home, repository]) {
    const file = path.join(root, 'project.txt'); await fs.writeFile(file, 'owned all-scope control')
    const permissions = { ...master(), storage: { scope: 'all' as const, access: 'readwrite' as const } }
    const read = authorizeTool(createReadTool(() => process.cwd()), fileAuthorization('worker', () => permissions, () => process.cwd(), 'file_path', false))
    const result = await read.call({ file_path: file }, {})
    expect(result.isError, result.output).toBe(false)
    expect(result.output).toContain('owned all-scope control')
  }
}, 20000)
