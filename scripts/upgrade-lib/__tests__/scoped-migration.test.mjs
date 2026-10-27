import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { describeMigration, executeMigration, assertNoInterruptedMigrations } from '../migration-transaction.mjs'
import { previewMigrations } from '../migrate.mjs'
import { fileURLToPath } from 'node:url'
const home = fileURLToPath(new URL('../../../', import.meta.url))
let root, moduleDir
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-migration-')))
  moduleDir = path.join(root, 'product/crabot-test')
  await fs.mkdir(path.join(moduleDir, 'upgrade'), { recursive: true })
  await fs.mkdir(path.join(root, 'data/test'), { recursive: true })
  await fs.writeFile(path.join(root, 'data/test/SCHEMA_VERSION'), 'v1\n')
  await fs.writeFile(path.join(root, 'data/test/original'), 'original')
  await fs.writeFile(path.join(moduleDir, 'schema_version'), 'v3')
  for (const n of [1, 2]) await fs.writeFile(path.join(moduleDir, `upgrade/from_v${n}_to_v${n + 1}.mjs`), '// synthetic conversion')
})
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })
async function adapter(writes = ['test/original', 'test/new'], reads = []) {
  await fs.writeFile(path.join(moduleDir, 'upgrade/scope.mjs'), `export const migrationScope = async () => (${JSON.stringify({ reads, writes })})`)
}
const description = () => describeMigration(moduleDir, path.join(root, 'data/test'), 'v1', 'v3')
it('unknown scope and broad/escaping scopes fail in read-only preview before any backup or script', async () => {
  await expect(previewMigrations(path.join(root, 'product'), path.join(root, 'data'))).rejects.toThrow('Missing migration scope')
  await expect(fs.stat(path.join(root, 'data/.upgrade-migrations'))).rejects.toThrow()
  await adapter(['test'])
  await expect(description()).rejects.toThrow('whole module')
})
it('one chain backup restores original mode/bytes and removes only declared new paths after step 2 fails', async () => {
  await adapter()
  await fs.chmod(path.join(root, 'data/test/original'), 0o640)
  const originalMode = (await fs.stat(path.join(root, 'data/test/original'))).mode & 0o777
  await fs.writeFile(path.join(root, 'data/test/unrelated'), 'keep')
  let calls = 0
  const result = await executeMigration(await description(), async () => {
    await fs.writeFile(path.join(root, 'data/test/original'), `converted-${calls}`)
    await fs.writeFile(path.join(root, 'data/test/new'), 'new')
    return { exitCode: ++calls === 2 ? 1 : 0 }
  })
  expect(result.ok).toBe(false)
  expect(await fs.readFile(path.join(root, 'data/test/SCHEMA_VERSION'), 'utf8')).toBe('v1\n')
  expect(await fs.readFile(path.join(root, 'data/test/original'), 'utf8')).toBe('original')
  expect((await fs.stat(path.join(root, 'data/test/original'))).mode & 0o777).toBe(originalMode)
  await expect(fs.stat(path.join(root, 'data/test/new'))).rejects.toThrow()
  expect(await fs.readFile(path.join(root, 'data/test/unrelated'), 'utf8')).toBe('keep')
  expect(await fs.readdir(path.join(root, 'data/.upgrade-migrations'))).toHaveLength(1)
  const success = await executeMigration(await description(), async () => ({ exitCode: 0 }))
  expect(success.ok).toBe(true)
  expect(await fs.readFile(path.join(root, 'data/test/SCHEMA_VERSION'), 'utf8')).toBe('v3\n')
})
it('backup failure and insufficient disk never start conversion or advance the version', async () => {
  await adapter()
  const convert = vi.fn()
  const copy = vi.spyOn(fs, 'copyFile').mockRejectedValue(new Error('disk fixture'))
  await expect(executeMigration(await description(), convert)).rejects.toThrow('disk fixture')
  expect(convert).not.toHaveBeenCalled()
  expect(await fs.readFile(path.join(root, 'data/test/SCHEMA_VERSION'), 'utf8')).toBe('v1\n')
  copy.mockRestore()
  await expect(assertNoInterruptedMigrations(path.join(root, 'data'))).rejects.toThrow('Incomplete migration backup')
})
it('space estimate checks only declared bytes and refuses before backup on insufficient space', async () => {
  await adapter()
  vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 0, bsize: 4096 })
  const convert = vi.fn()
  await expect(executeMigration(await description(), convert)).rejects.toThrow('Insufficient space')
  expect(convert).not.toHaveBeenCalled()
  expect(await fs.readFile(path.join(root, 'data/test/original'), 'utf8')).toBe('original')
})
it('crash with unknown writes stays blocked even if SCHEMA_VERSION was advanced; no automatic replay', async () => {
  await adapter()
  const d = await description()
  await executeMigration(d, async () => ({ exitCode: 0 }))
  const state = path.join(root, 'data/.upgrade-migrations', d.id, 'state.json')
  const value = JSON.parse(await fs.readFile(state, 'utf8')); value.phase = 'running'; await fs.writeFile(state, JSON.stringify(value))
  await expect(assertNoInterruptedMigrations(path.join(root, 'data'))).rejects.toThrow('startup blocked')
  const convert = vi.fn()
  await expect(executeMigration(d, convert)).rejects.toThrow('startup blocked')
  expect(convert).not.toHaveBeenCalled()
})
it('active instance and competing operation cannot enter conversion', async () => {
  await adapter()
  await fs.writeFile(path.join(root, 'data/mm.pid'), String(process.pid))
  await expect(executeMigration(await description(), vi.fn())).rejects.toThrow('Stop Crabot')
  await expect(fs.stat(path.join(root, 'data/.upgrade-migrations'))).rejects.toThrow()
})
it('all supported Memory chains declare cross-module cleanup, SQLite companions and deterministic rename targets', async () => {
  const data = path.join(root, 'data/memory')
  await fs.mkdir(data)
  await fs.mkdir(path.join(data, 'lancedb'))
  await fs.mkdir(path.join(root, 'data/admin/module-configs'), { recursive: true })
  await fs.writeFile(path.join(root, 'data/admin/module-configs/memory-one.json'), '{}')
  await fs.writeFile(path.join(root, 'data/admin/module-configs/agent-one.json'), '{}')
  for (let from = 0; from < 5; from++) {
    const d = await describeMigration(path.join(home, 'crabot-memory'), data, from ? `v${from}` : null, 'v5')
    expect(d.scope.writes).toContain(path.normalize('memory/long_term_v2.db-wal'))
    expect(d.scope.reads.concat(d.scope.writes)).toContain(path.normalize('memory/short_term.db'))
    if (from <= 2) {
      expect(d.scope.writes).toContain(path.normalize('admin/module-configs/memory-one.json'))
      expect(d.scope.writes).toContain(path.join('memory', `lancedb.deprecated.${d.id}`))
      expect(d.scope.writes).not.toContain(path.normalize('admin/module-configs/agent-one.json'))
    }
    expect(d.scope.writes).not.toContain(path.normalize('memory/metadata.db'))
    expect(d.scripts).toHaveLength(5 - from)
  }
})

it('proven conversion keeps the standalone marker and the common entry commits without replay or another backup', async () => {
  await adapter()
  const d = await description(), convert = vi.fn(async () => ({ exitCode: 0 }))
  await executeMigration(d, convert, { advanceVersion: false })
  expect(await fs.readFile(path.join(root, 'data/test/SCHEMA_VERSION'), 'utf8')).toBe('v1\n')
  expect(convert).toHaveBeenCalledTimes(2)
  convert.mockClear()
  const { runMigrations } = await import('../migrate.mjs')
  expect((await runMigrations(path.join(root, 'product'), path.join(root, 'data'), convert, { info() {} })).ok).toBe(true)
  expect(convert).not.toHaveBeenCalled()
  expect(await fs.readFile(path.join(root, 'data/test/SCHEMA_VERSION'), 'utf8')).toBe('v3\n')
  expect(await fs.readdir(path.join(root, 'data/.upgrade-migrations'))).toHaveLength(1)
})
it('live recorded modules block migration even when all legacy PID files are missing', async () => {
  await adapter()
  await fs.mkdir(path.join(root, 'data/module-runtime-registry/records'), { recursive: true })
  await fs.writeFile(path.join(root, 'data/module-runtime-registry/records/fixture.json'), JSON.stringify({ schema_version: 1, root_pid: process.pid, module_port: 1 }))
  const convert = vi.fn()
  await expect(executeMigration(await description(), convert)).rejects.toThrow('recorded module is still running')
  expect(convert).not.toHaveBeenCalled()
})

it('recovery retains original declared scope after conversion creates files that change discovery', async () => {
  await adapter()
  await fs.writeFile(path.join(moduleDir, 'upgrade/scope.mjs'), `import fs from 'node:fs'; import path from 'node:path'; export const migrationScope = async ({dataRoot}) => ({ reads: [], writes: fs.existsSync(path.join(dataRoot,'test/new')) ? ['test/new','test/changed-discovery'] : ['test/new'] })`)
  const first = await description()
  await executeMigration(first, async () => { await fs.writeFile(path.join(root, 'data/test/new'), 'created'); return { exitCode: 0 } }, { advanceVersion: false })
  const recovered = await description()
  expect(recovered.scope).toEqual(first.scope)
  const convert = vi.fn()
  const { runMigrations } = await import('../migrate.mjs')
  expect((await runMigrations(path.join(root, 'product'), path.join(root, 'data'), convert, { info() {} })).ok).toBe(true)
  expect(convert).not.toHaveBeenCalled()
})

const transactionDirectory = () => path.join(root, 'data/.upgrade-migrations/crabot-test-v1-v3')
async function failedAttempt(reads = []) {
  await adapter(['test/original', 'test/new'], reads)
  await executeMigration(await description(), async () => {
    await fs.writeFile(path.join(root, 'data/test/original'), 'failed conversion')
    return { exitCode: 1 }
  })
  await fs.writeFile(path.join(moduleDir, 'upgrade/from_v1_to_v2.mjs'), '// repaired conversion')
}
it('verified rollback previews a repaired scope without writes and archives old evidence before a new attempt', async () => {
  await failedAttempt()
  const oldDirectory = transactionDirectory()
  const oldPlan = await fs.readFile(path.join(oldDirectory, 'plan.json'))
  const oldState = await fs.readFile(path.join(oldDirectory, 'state.json'))
  await adapter(['test/original', 'test/new', 'test/extra'])
  const repaired = await description()
  expect(repaired.scope.writes).toContain(path.normalize('test/extra'))
  expect(await fs.readFile(path.join(oldDirectory, 'plan.json'))).toEqual(oldPlan)
  await expect(fs.stat(path.join(root, 'data/.upgrade-migrations-history'))).rejects.toThrow()
  const convert = vi.fn(async () => ({ exitCode: 0 }))
  expect((await executeMigration(repaired, convert)).ok).toBe(true)
  expect(convert).toHaveBeenCalledTimes(2)
  const history = path.join(root, 'data/.upgrade-migrations-history')
  const archived = await fs.readdir(history)
  expect(archived).toHaveLength(1)
  expect(await fs.readFile(path.join(history, archived[0], 'plan.json'))).toEqual(oldPlan)
  expect(await fs.readFile(path.join(history, archived[0], 'state.json'))).toEqual(oldState)
  expect(await fs.readFile(path.join(history, archived[0], 'backup/test/original'), 'utf8')).toBe('original')
  expect(await fs.readFile(path.join(root, 'data/test/SCHEMA_VERSION'), 'utf8')).toBe('v3\n')
})
for (const changed of ['running', 'converted', 'completed', 'unknown', 'binding', 'backup', 'writes', 'reads', 'owner']) {
  it(`a repaired migration cannot bypass original ${changed} verification`, async () => {
    await fs.writeFile(path.join(root, 'data/test/reference'), 'input')
    await failedAttempt(['test/reference'])
    const directory = transactionDirectory(), stateFile = path.join(directory, 'state.json')
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    if (['running', 'converted', 'completed', 'unknown'].includes(changed)) state.phase = changed
    if (changed === 'binding') state.plan_sha256 = '0'.repeat(64)
    if (changed === 'backup') await fs.writeFile(path.join(directory, 'backup/test/original'), 'bad backup')
    if (changed === 'writes') await fs.writeFile(path.join(root, 'data/test/original'), 'new business data')
    if (changed === 'reads') await fs.writeFile(path.join(root, 'data/test/reference'), 'new input')
    if (changed === 'owner') {
      const { hash } = await import('../scoped-data.mjs')
      const plan = JSON.parse(await fs.readFile(path.join(directory, 'plan.json'), 'utf8'))
      plan.description.data_root = path.join(root, 'another-instance')
      const bytes = JSON.stringify(plan); state.plan_sha256 = hash(bytes)
      await fs.writeFile(path.join(directory, 'plan.json'), bytes)
    }
    await fs.writeFile(stateFile, JSON.stringify(state))
    await expect(description()).rejects.toThrow()
    await expect(fs.stat(path.join(root, 'data/.upgrade-migrations-history'))).rejects.toThrow()
    expect(await fs.readFile(stateFile, 'utf8')).toBe(JSON.stringify(state))
  })
}
it('execution rechecks rollback inputs under the lock even after a successful preview', async () => {
  await failedAttempt()
  const repaired = await description()
  await fs.writeFile(path.join(root, 'data/test/original'), 'changed after preview')
  const convert = vi.fn()
  await expect(executeMigration(repaired, convert)).rejects.toThrow('inputs changed')
  expect(convert).not.toHaveBeenCalled()
  await expect(fs.stat(path.join(root, 'data/.upgrade-migrations-history'))).rejects.toThrow()
})
it('archive failure leaves the original transaction intact and never runs repaired conversion', async () => {
  await failedAttempt()
  const repaired = await description(), rename = fs.rename.bind(fs)
  vi.spyOn(fs, 'rename').mockImplementation((source, destination) => {
    if (source === transactionDirectory()) return Promise.reject(new Error('archive fixture failure'))
    return rename(source, destination)
  })
  const convert = vi.fn()
  await expect(executeMigration(repaired, convert)).rejects.toThrow('archive fixture failure')
  expect(convert).not.toHaveBeenCalled()
  expect(JSON.parse(await fs.readFile(path.join(transactionDirectory(), 'state.json'), 'utf8')).phase).toBe('rolled_back')
})
it('interruption after archive but before new transaction leaves original evidence and permits a fresh attempt', async () => {
  await failedAttempt()
  const repaired = await description(), mkdir = fs.mkdir.bind(fs)
  const fail = vi.spyOn(fs, 'mkdir').mockImplementation((directory, options) => {
    if (directory === transactionDirectory()) return Promise.reject(new Error('before new transaction fixture'))
    return mkdir(directory, options)
  })
  const convert = vi.fn(async () => ({ exitCode: 0 }))
  await expect(executeMigration(repaired, convert)).rejects.toThrow('before new transaction fixture')
  expect(convert).not.toHaveBeenCalled()
  fail.mockRestore()
  await assertNoInterruptedMigrations(path.join(root, 'data'))
  expect((await executeMigration(await description(), convert)).ok).toBe(true)
  expect(await fs.readdir(path.join(root, 'data/.upgrade-migrations-history'))).toHaveLength(1)
})
