import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { checkFileAccess } from '../../src/permissions/tool-authorization.js'
import { executionAdmission } from '../../src/workers/execution-policy.js'
import { boundedRequestPermissions } from '../../src/workers/harness/request-permissions.js'
import { WorkerContextStore } from '../../src/workers/harness/context-store.js'
import { CLI_DOMAINS, type ResolvedPermissions, type StoragePermission } from '../../src/types.js'
let root: string
const permissions = (storage: StoragePermission | null): ResolvedPermissions => ({
  tool_access: { memory: false, messaging: true, task: false, mcp_skill: false, file_io: true, browser: false, shell: true, remote_exec: false, desktop: false },
  cli_access: Object.fromEntries(CLI_DOMAINS.map(domain => [domain, 'none'])) as ResolvedPermissions['cli_access'], storage, memory_scopes: [],
})
const source = (storage: StoragePermission | null) => ({ kind: 'group' as const, subject_id: 'channel::group', is_master: false, resolved: permissions(storage) })
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-all-directories-'))) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
it('all allows actual external file operations while null, readonly and closed entry still reject', async () => {
  const file = path.join(root, 'result.txt'), all = permissions({ scope: 'all', access: 'readwrite' })
  expect(await checkFileAccess(all, file, root, true)).toEqual({ allowed: true })
  await fs.writeFile(file, 'actual external result')
  expect(await checkFileAccess(permissions({ scope: 'all', access: 'read' }), file, root, false)).toEqual({ allowed: true })
  expect((await checkFileAccess(permissions({ scope: 'all', access: 'read' }), file, root, true)).allowed).toBe(false)
  expect((await checkFileAccess(permissions(null), file, root, false)).allowed).toBe(false)
  expect((await checkFileAccess({ ...all, tool_access: { ...all.tool_access, file_io: false } }, file, root, false)).allowed).toBe(false)
  expect(await fs.readFile(file, 'utf8')).toBe('actual external result')
})
it('all intersects only the same source, preserves old null and canonical directory restrictions', async () => {
  const narrow = path.join(root, 'project'); await fs.mkdir(narrow)
  const all = { scope: 'all' as const, access: 'readwrite' as const }, read = { scope: 'all' as const, access: 'read' as const }
  expect((await boundedRequestPermissions(source(all), source(read))).storage).toEqual(read)
  for (const pair of [[all, { workspace_path: narrow, access: 'read' }], [{ workspace_path: narrow, access: 'read' }, all]] as const) {
    expect((await boundedRequestPermissions(source(pair[0]), source(pair[1]))).storage).toEqual({ workspace_path: narrow, access: 'read' })
  }
  expect((await boundedRequestPermissions(source(null), source(all))).storage).toBeNull()
  await expect(boundedRequestPermissions(source(all), { ...source(all), subject_id: 'other' })).rejects.toThrow('different')
})
it('explicit full-host scope admits native CLI on Windows but does not grant missing switches', () => {
  expect(executionAdmission('codex', permissions({ scope: 'all', access: 'readwrite' }), 'win32').status).toBe('allowed')
  expect(executionAdmission('codex', permissions({ scope: 'all', access: 'read' }), 'win32').status).toBe('blocked')
  expect(executionAdmission('codex', permissions({ scope: 'all', workspace_path: '/', access: 'readwrite' } as StoragePermission), 'linux').status).toBe('blocked')
  const noShell = permissions({ scope: 'all', access: 'readwrite' }); noShell.tool_access.shell = false
  expect(executionAdmission('codex', noShell, 'win32').status).toBe('blocked')
})
it('real persisted contexts accept all, preserve old null and reject mixed scope records', async () => {
  const store = new WorkerContextStore(root), principal = permissions({ scope: 'all', access: 'readwrite' })
  await store.write('worker', { principal_permissions: principal })
  expect((await store.read('worker'))?.principal_permissions).toEqual(principal)
  await store.write('old', { principal_permissions: permissions(null) })
  expect((await store.read('old'))?.principal_permissions?.storage).toBeNull()
  await expect(store.write('bad', { principal_permissions: permissions({ scope: 'all', workspace_path: root, access: 'readwrite' } as StoragePermission) })).rejects.toThrow('invalid')
})

it.skipIf(process.platform !== 'win32' || path.parse(process.cwd()).root.toLowerCase() === path.parse(os.tmpdir()).root.toLowerCase())('all reads across the native Windows repository and temporary drives', async () => {
  const all = permissions({ scope: 'all', access: 'readwrite' }), local = path.join(root, 'local.txt'), repository = path.join(process.cwd(), 'package.json')
  await fs.writeFile(local, 'temporary drive')
  for (const file of [local, repository]) {
    expect(await checkFileAccess(all, file, root, false)).toEqual({ allowed: true })
    expect(await fs.readFile(file, 'utf8')).not.toBe('')
  }
})
