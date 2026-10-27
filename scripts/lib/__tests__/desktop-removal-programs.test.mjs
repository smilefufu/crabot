import test from 'node:test'
import assert from 'node:assert/strict'
import fsSync, { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import management from '../desktop-management.cjs'
import identity from '../process-identity.cjs'
import { privateJson } from '../desktop-preparation-files.mjs'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
let windowsFixtureObserved = false
const recordFor = bytes => ({ type: 'file', size: Buffer.byteLength(bytes), sha256: digest(bytes), ...(process.platform === 'win32' ? {} : { mode: 0o644 }) })
async function fixture(t, programCount = 0) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-program-audit-')))
  t.after(() => fs.rm(temporary, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }))
  const root = management.ensurePrivateDataRoot(path.join(temporary, 'installation')), data = management.ensurePrivateDataRoot(path.join(root, 'data'))
  const launcher = process.platform === 'win32' ? 'crabot.exe' : 'crabot', launcherBytes = 'inert launcher, never executed'
  const files = { 'nested/program.txt': recordFor('Core bytes'), ['bin/' + launcher]: recordFor(launcherBytes) }
  if (process.platform !== 'win32') files['bin/' + launcher].mode = 0o755
  if (process.platform !== 'win32') files['nested/relative-link'] = { type: 'link', target: 'program.txt' }
  for (let index = 0; index < programCount; index++) files['nested/finite-' + index + '.txt'] = recordFor('Core bytes')
  const inventory = JSON.stringify({ schema_version: 1, files }) + '\n'
  const selection = { schema_version: 1, version: '1.2.3', gui_id: randomUUID(), core_id: digest(inventory) }
  const core = path.join(root, 'releases', selection.core_id), gui = path.join(root, 'app/releases', selection.gui_id)
  for (const dir of [path.join(core, 'nested'), path.join(core, 'bin'), gui, path.join(root, 'bin')]) await fs.mkdir(dir, { recursive: true })
  for (let index = 0; index < programCount; index++) await fs.writeFile(path.join(core, 'nested/finite-' + index + '.txt'), 'Core bytes')
  await fs.writeFile(path.join(core, 'nested/program.txt'), 'Core bytes'); await fs.writeFile(path.join(core, 'bin', launcher), launcherBytes)
  await fs.writeFile(path.join(root, 'bin', launcher), launcherBytes)
  if (process.platform !== 'win32') { await fs.chmod(path.join(core, 'bin', launcher), 0o755); await fs.chmod(path.join(root, 'bin', launcher), 0o755); await fs.symlink('program.txt', path.join(core, 'nested/relative-link')) }
  await fs.writeFile(path.join(gui, 'program.txt'), 'GUI bytes')
  const coreText = { release: JSON.stringify({ schema_version: 1, version: selection.version, platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false, inventory_sha256: selection.core_id }) + '\n', inventory,
    host: JSON.stringify({ schema_version: 2, platform: process.platform, arch: process.arch }) + '\n' }
  for (const [key, name] of [['release', 'core-release.json'], ['inventory', 'core-files.json'], ['host', 'desktop-host.json']]) await fs.writeFile(path.join(core, name), coreText[key])
  const stat = await fs.lstat(root, { bigint: true }), installationId = randomUUID(), operationId = randomUUID()
  await privateJson(path.join(root, 'desktop-installation.json'), { schema_version: 1, installation_id: installationId, owner: identity.inspectProcess(process.pid).owner,
    install_root: root, root_identity: { dev: String(stat.dev), ino: String(stat.ino) }, paths: { app: 'app/releases', core: 'releases', data: 'data', bin: 'bin' } })
  await privateJson(path.join(root, 'current-release.json'), selection)
  const proof = { schema_version: 1, installation_id: installationId, operation_id: operationId, source_selection: selection,
    payload: { schema_version: 1, platform: process.platform, arch: process.arch, selection, gui: { 'program.txt': recordFor('GUI bytes') } }, core: coreText }
  const job = management.ensurePrivateDataRoot(path.join(management.ensurePrivateDataRoot(path.join(root, 'app/removals')), operationId))
  await privateJson(path.join(job, 'proof.json'), proof)
  await privateJson(path.join(root, '.desktop-removal.json'), { schema_version: 1, installation_id: installationId, operation_id: operationId, source_selection: selection, phase: 'removing', proof_sha256: digest(JSON.stringify(proof) + '\n') })
  await fs.writeFile(path.join(data, 'user.txt'), 'preserved data and runtime bases')
  for (const [name, content] of [['runtime-bases/python-retained/base.txt', 'retained interpreter'], ['mcp-envs/server/packages.txt', 'retained MCP dependencies'], ['workspaces/project/work.txt', 'retained project']]) {
    const file = path.join(data, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content)
  }
  if (process.platform === 'win32' && !windowsFixtureObserved) {
    windowsFixtureObserved = true
    console.log('CRABOT_FINITE_WINDOWS_LOCATION ' + JSON.stringify({ native_canonical_root: fsSync.realpathSync.native(root) === root,
      root_private: identity.isPrivateDirectory(root), data_private: identity.isPrivateDirectory(data),
      owned_bases: ['app', 'app/releases', 'releases', 'data', 'bin'].every(name => identity.isOwnedDirectory(path.join(root, name))),
      private_records: ['desktop-installation.json', 'current-release.json', '.desktop-removal.json'].every(name => identity.isPrivateFile(path.join(root, name))),
      owner_matches: identity.inspectProcess(process.pid).owner === JSON.parse(await fs.readFile(path.join(root, 'desktop-installation.json'), 'utf8')).owner }))
  }
  return { root, data, core, gui, launcher, temporary, operationId }
}
for (const mode of ['matching', 'partial', 'missing-core', 'changed-file', 'new-directory', 'replaced-directory', 'hardlink', 'wrong-operation', 'changed-proof', 'changed-selection', 'bad-metadata', 'changed-launcher', 'cancelled', 'read-race', 'redirected-missing-gui', 'missing-core-parent', 'wrong-file-link', 'job-race', 'directory-race']) test('read-only remaining programs use original proof without loading Core: ' + mode, { skip: process.platform === 'win32' && mode === 'wrong-file-link' }, async t => {
  const f = await fixture(t), { inspectDesktopRemovalPrograms } = await import('../desktop-removal-programs.mjs')
  const input = { installRoot: f.root, operationId: f.operationId }, source = path.join(f.core, 'nested/program.txt')
  if (mode === 'partial') await fs.unlink(source)
  if (mode === 'missing-core-parent') await fs.rm(path.dirname(f.core), { recursive: true })
  if (mode === 'redirected-missing-gui') { const parent = path.dirname(f.gui); await fs.rename(parent, parent + '-original'); await fs.mkdir(path.join(f.temporary, 'empty')); await fs.symlink(path.join(f.temporary, 'empty'), parent, process.platform === 'win32' ? 'junction' : 'dir') }
  if (mode === 'wrong-file-link') { await fs.unlink(source); await fs.symlink(path.join(f.data, 'user.txt'), source) }
  if (mode === 'missing-core') await fs.rm(f.core, { recursive: true })
  if (mode === 'changed-file') await fs.writeFile(source, 'changed Core bytes')
  if (mode === 'bad-metadata') await fs.appendFile(path.join(f.core, 'core-release.json'), ' ')
  if (mode === 'changed-launcher') await fs.appendFile(path.join(f.root, 'bin', f.launcher), ' user change')
  if (mode === 'new-directory') { await fs.mkdir(path.join(f.core, 'user-work')); await fs.writeFile(path.join(f.core, 'user-work/do-not-traverse'), 'user work') }
  if (mode === 'replaced-directory') { await fs.rename(path.join(f.core, 'nested'), path.join(f.core, 'original-nested')); await fs.symlink(path.join(f.core, 'original-nested'), path.join(f.core, 'nested'), process.platform === 'win32' ? 'junction' : 'dir') }
  if (mode === 'hardlink') await fs.link(source, path.join(f.data, 'linked-program.txt'))
  if (mode === 'wrong-operation') input.operationId = randomUUID()
  if (mode === 'changed-proof') await fs.appendFile(path.join(f.root, 'app/removals', f.operationId, 'proof.json'), ' ')
  if (mode === 'changed-selection') await privateJson(path.join(f.root, 'current-release.json'), { schema_version: 1, version: '1.2.4', gui_id: randomUUID(), core_id: '2'.repeat(64) }, true)
  if (mode === 'cancelled') input.signal = AbortSignal.abort()
  let raced = false, replaced = false
  if (['read-race', 'job-race', 'directory-race'].includes(mode)) {
    const open = fs.open
    t.mock.method(fs, 'open', async (...args) => {
      if (args[0] === source && mode === 'directory-race') {
        // Replace between the scanner's stat and open. An already open file
        // can prevent renaming its parent on Windows; that is no replacement.
        const directory = path.dirname(source)
        await fs.rename(directory, directory + '-old'); await fs.mkdir(directory); await fs.writeFile(source, 'Core bytes')
        replaced = true
      }
      const handle = await open(...args)
      try {
        if (args[0] === source) {
          raced = true
          if (mode === 'read-race') await fs.appendFile(source, ' changed while opening')
          if (mode === 'job-race') { const file = path.join(f.root, '.desktop-removal.json'), record = JSON.parse(await fs.readFile(file)); await privateJson(file, { ...record, operation_id: randomUUID() }, true) }
        }
        return handle
      } catch (error) { await handle.close(); throw error }
    })
  }
  const beforeData = await fs.readFile(path.join(f.data, 'user.txt')), beforeRecord = await fs.readFile(path.join(f.root, '.desktop-removal.json'))
  if (['wrong-operation', 'changed-proof', 'changed-selection', 'cancelled', 'job-race', 'directory-race', 'redirected-missing-gui', 'missing-core-parent'].includes(mode)) await assert.rejects(inspectDesktopRemovalPrograms(input))
  else {
    const result = await inspectDesktopRemovalPrograms(input)
    assert.equal(result.matched.some(file => file.includes('/data/') || file.startsWith('data/')), false)
    if (mode === 'matching') { assert.equal(result.retained.length, 0); assert.equal(result.missing.length, 0); assert.ok(result.matched.length >= 7) }
    if (['partial', 'missing-core'].includes(mode)) assert.ok(result.missing.includes(path.relative(f.root, source).split(path.sep).join('/')))
    if (['changed-file', 'hardlink', 'read-race', 'wrong-file-link'].includes(mode)) { assert.ok(result.retained.some(item => item.path.endsWith('nested/program.txt'))); assert.equal(result.matched.includes(path.relative(f.root, source).split(path.sep).join('/')), false) }
    if (mode === 'read-race') assert.equal(raced, true)
    if (mode === 'new-directory') { assert.ok(result.retained.some(item => item.path.endsWith('/user-work'))); assert.equal(result.retained.some(item => item.path.endsWith('/do-not-traverse')), false) }
    if (mode === 'replaced-directory') { assert.ok(result.retained.some(item => item.path.endsWith('/nested'))); assert.equal(result.matched.some(file => file.endsWith('nested/program.txt')), false) }
    if (mode === 'bad-metadata') assert.ok(result.retained.some(item => item.path.endsWith('/core-release.json')))
    if (mode === 'changed-launcher') assert.ok(result.retained.some(item => item.path === 'bin/' + f.launcher))
  }
  if (mode === 'directory-race') { assert.equal(raced, true); assert.equal(replaced, true) }
  assert.deepEqual(await fs.readFile(path.join(f.data, 'user.txt')), beforeData); if (mode !== 'job-race') assert.deepEqual(await fs.readFile(path.join(f.root, '.desktop-removal.json')), beforeRecord)
})


// Mutation cases use only the inert private program fixture. Native observer
// outcomes below are controlled explicitly; real observation has a separate case.
for (const mode of ['owned', 'partial', 'changed-file', 'unknown-directory', 'missing-lock', 'wrong-operation', 'wrong-installation', 'before-removing', 'running', 'referenced', 'unknown-reference', 'incomplete-observer', 'changed-after-observation', 'lost-unlink-reply', 'root-preparation', 'module-pending', 'lost-lock-after-observation', 'changed-proof-after-observation', 'directory-after-observation', 'reappeared-after-unlink', 'late-hardlink', 'late-file-link']) test('program removal holds the same job and preserves all user data: ' + mode, { timeout: 10000, skip: process.platform === 'win32' && mode === 'late-file-link' }, async t => {
  const f = await fixture(t), locks = await import('../cli-lock.mjs')
  const held = []
  try {
    held.push(await locks.acquireExistingCliLock(f.root, 'fixture-program-removal'))
    held.push(await locks.acquireExistingCliLock(f.data, 'fixture-program-removal'))
    const { removeDesktopRemovalPrograms } = await import('../desktop-removal-delete.mjs')
    const target = path.join(f.core, 'nested/program.txt'), input = { installRoot: f.root, operationId: f.operationId }
    if (mode === 'partial') await fs.unlink(target)
    if (mode === 'changed-file') await fs.writeFile(target, 'user changed program')
    if (mode === 'unknown-directory') { await fs.mkdir(path.join(f.core, 'custom')); await fs.writeFile(path.join(f.core, 'custom/user.txt'), 'user additions') }
    if (mode === 'missing-lock') locks.releaseCliLock(held.pop())
    if (mode === 'wrong-operation') input.operationId = randomUUID()
    if (mode === 'wrong-installation') { const file = path.join(f.root, 'desktop-installation.json'); await privateJson(file, { ...JSON.parse(await fs.readFile(file)), installation_id: randomUUID() }, true) }
    if (mode === 'before-removing') {
      const file = path.join(f.root, '.desktop-removal.json'), record = JSON.parse(await fs.readFile(file))
      await privateJson(file, { ...record, phase: 'stopping' }, true)
    }
    if (mode === 'running') await fs.writeFile(path.join(f.data, 'mm.pid'), String(process.pid))
    if (mode === 'root-preparation') await fs.writeFile(path.join(f.root, '.desktop-installing.json'), '{}')
    if (mode === 'module-pending') { await fs.mkdir(path.join(f.data, 'module-runtime-registry/records'), { recursive: true }); await fs.writeFile(path.join(f.data, 'module-runtime-registry/records/pending.json'), '{}') }
    let observed = 0
    t.mock.method(identity, 'inspectProgramReferences', async query => {
      observed++; assert.ok(query.roots.includes(f.core)); assert.ok(query.roots.includes(f.gui))
      assert.equal(query.files.some(file => file.startsWith(f.data + path.sep)), false)
      if (mode === 'changed-after-observation') await fs.writeFile(target, 'changed after OS observation')
      if (observed === 1 && mode === 'late-hardlink') await fs.link(target, path.join(f.data, 'linked-program.txt'))
      if (observed === 1 && mode === 'late-file-link') { await fs.unlink(target); await fs.symlink(path.join(f.data, 'user.txt'), target) }
      if (mode === 'lost-lock-after-observation') locks.releaseCliLock(held.pop())
      if (mode === 'changed-proof-after-observation') await fs.appendFile(path.join(f.root, 'app/removals', f.operationId, 'proof.json'), ' ')
      if (mode === 'directory-after-observation') { await fs.rename(path.dirname(target), path.dirname(target) + '-preserved'); await fs.mkdir(path.dirname(target)); await fs.writeFile(target, 'Core bytes') }
      return { complete: !['unknown-reference', 'incomplete-observer'].includes(mode), incomplete: mode === 'incomplete-observer',
        processes: mode === 'referenced' ? [{ pid: process.pid }] : [], unknown_pids: mode === 'unknown-reference' ? [process.pid] : [] }
    })
    let reappearance
    if (mode === 'reappeared-after-unlink') {
      const unlink = fsSync.unlinkSync
      reappearance = t.mock.method(fsSync, 'unlinkSync', file => { unlink(file); if (file === target) fsSync.writeFileSync(target, 'Core bytes') })
    }
    const beforeData = await fs.readFile(path.join(f.data, 'user.txt')), beforeRecord = await fs.readFile(path.join(f.root, '.desktop-removal.json'))
    const refused = ['missing-lock', 'wrong-operation', 'wrong-installation', 'before-removing', 'running', 'referenced', 'unknown-reference', 'incomplete-observer', 'root-preparation', 'module-pending', 'lost-lock-after-observation', 'changed-proof-after-observation', 'directory-after-observation'].includes(mode)
    if (mode === 'lost-unlink-reply') {
      const unlink = fsSync.unlinkSync; let removed = 0
      const fault = t.mock.method(fsSync, 'unlinkSync', file => {
        unlink(file)
        if (file === target) { removed++; throw Object.assign(new Error('program unlink reply lost'), { code: 'EIO' }) }
      })
      await assert.rejects(removeDesktopRemovalPrograms(input), { code: 'EIO' }); fault.mock.restore()
      assert.equal(removed, 1)
    }
    if (refused) {
      await assert.rejects(removeDesktopRemovalPrograms(input))
      assert.equal(await fs.readFile(target, 'utf8'), 'Core bytes'); assert.equal(await fs.readFile(path.join(f.gui, 'program.txt'), 'utf8'), 'GUI bytes')
    } else {
      const result = await removeDesktopRemovalPrograms(input)
      if (['changed-file', 'changed-after-observation', 'reappeared-after-unlink', 'late-hardlink', 'late-file-link'].includes(mode)) {
        assert.ok(result.retained.some(value => value.path.endsWith('nested/program.txt'))); assert.ok(await fs.lstat(target))
      } else await assert.rejects(fs.lstat(target), { code: 'ENOENT' })
      if (mode === 'unknown-directory') assert.equal(await fs.readFile(path.join(f.core, 'custom/user.txt'), 'utf8'), 'user additions')
      await assert.rejects(fs.lstat(path.join(f.gui, 'program.txt')), { code: 'ENOENT' })
      if (mode === 'reappeared-after-unlink') {
        reappearance.mock.restore()
        const retried = await removeDesktopRemovalPrograms(input); assert.equal(retried.removed.length, 1); assert.equal(retried.retained.length, 0)
      } else if (mode !== 'changed-after-observation') assert.equal((await removeDesktopRemovalPrograms(input)).removed.length, 0)
    }
    if (!['missing-lock', 'wrong-operation', 'wrong-installation', 'before-removing', 'running', 'root-preparation', 'module-pending'].includes(mode)) assert.ok(observed >= 1)
    if (mode === 'late-hardlink') assert.equal(await fs.readFile(path.join(f.data, 'linked-program.txt'), 'utf8'), 'Core bytes')
    assert.deepEqual(await fs.readFile(path.join(f.data, 'user.txt')), beforeData)
    assert.deepEqual(await fs.readFile(path.join(f.root, '.desktop-removal.json')), beforeRecord)
    for (const [name, content] of [['runtime-bases/python-retained/base.txt', 'retained interpreter'], ['mcp-envs/server/packages.txt', 'retained MCP dependencies'], ['workspaces/project/work.txt', 'retained project']]) assert.equal(await fs.readFile(path.join(f.data, name), 'utf8'), content)
    assert.ok(await fs.lstat(path.join(f.root, 'desktop-installation.json'))); assert.ok(await fs.lstat(path.join(f.root, 'current-release.json')))
  } finally { for (const lock of held.reverse()) locks.releaseCliLock(lock) }
})


test('actual native program observation either proves the private removal or safely retains it', { timeout: 70000 }, async t => {
  const f = await fixture(t), locks = await import('../cli-lock.mjs'), held = [], observations = []
  const inspect = identity.inspectProgramReferences
  t.mock.method(identity, 'inspectProgramReferences', async request => {
    const started = performance.now()
    try { return await inspect(request) }
    finally { observations.push(Math.round(performance.now() - started)) }
  })
  try {
    held.push(await locks.acquireExistingCliLock(f.root, 'fixture-actual-program-removal'))
    held.push(await locks.acquireExistingCliLock(f.data, 'fixture-actual-program-removal'))
    const { removeDesktopRemovalPrograms } = await import('../desktop-removal-delete.mjs')
    let outcome
    try {
      const result = await removeDesktopRemovalPrograms({ installRoot: f.root, operationId: f.operationId })
      assert.ok(result.removed.length >= 7); assert.equal(result.retained.length, 0)
      outcome = 'removed-proven-programs'
    } catch (error) {
      assert.equal(error.code, 'CRABOT_DESKTOP_PROGRAM_REFERENCES')
      if (error.stage === 'before-files') {
        assert.equal(await fs.readFile(path.join(f.core, 'nested/program.txt'), 'utf8'), 'Core bytes')
        assert.equal(await fs.readFile(path.join(f.gui, 'program.txt'), 'utf8'), 'GUI bytes')
        outcome = 'retained-unverified-observation'
      } else {
        assert.ok(['before-group', 'before-directories', 'after-directories'].includes(error.stage))
        outcome = 'retained-after-partial-removal'
      }
    }
    assert.equal(await fs.readFile(path.join(f.data, 'user.txt'), 'utf8'), 'preserved data and runtime bases')
    assert.equal(JSON.parse(await fs.readFile(path.join(f.root, '.desktop-removal.json'))).phase, 'removing')
    assert.ok(observations.length > 0 && observations.length <= 5)
    console.log('CRABOT_PRIVATE_PROGRAM_REMOVAL ' + JSON.stringify({ platform: process.platform, actual_native_observer: true, outcome, observation_ms: observations,
      real_installation_changed: false, business_mm_started: false, fence_preserved: true }))
  } finally { for (const lock of held.reverse()) locks.releaseCliLock(lock) }
})


test('proof changed during the final file match preserves that file and the removal fence', async t => {
  const f = await fixture(t), locks = await import('../cli-lock.mjs'), held = []
  try {
    held.push(await locks.acquireExistingCliLock(f.root, 'fixture-late-proof'))
    held.push(await locks.acquireExistingCliLock(f.data, 'fixture-late-proof'))
    const { removeDesktopRemovalPrograms } = await import('../desktop-removal-delete.mjs')
    const target = path.join(f.core, 'nested/program.txt'), before = await fs.readFile(path.join(f.root, '.desktop-removal.json'))
    t.mock.method(identity, 'inspectProgramReferences', async () => ({ complete: true, incomplete: false, processes: [], unknown_pids: [] }))
    const open = fs.open; let checks = 0, injected = false
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await open(...args)
      try {
        if (args[0] === target && ++checks === 2) {
          injected = true; await fs.appendFile(path.join(f.root, 'app/removals', f.operationId, 'proof.json'), ' ')
        }
        return handle
      } catch (error) { await handle.close(); throw error }
    })
    await assert.rejects(removeDesktopRemovalPrograms({ installRoot: f.root, operationId: f.operationId }))
    assert.equal(injected, true); assert.equal(await fs.readFile(target, 'utf8'), 'Core bytes')
    assert.deepEqual(await fs.readFile(path.join(f.root, '.desktop-removal.json')), before)
    assert.equal(await fs.readFile(path.join(f.data, 'user.txt'), 'utf8'), 'preserved data and runtime bases')
  } finally { for (const lock of held.reverse()) locks.releaseCliLock(lock) }
})


test('a new observed holder stops remaining program removal and preserves its fence', async t => {
  const f = await fixture(t), locks = await import('../cli-lock.mjs'), held = []
  try {
    held.push(await locks.acquireExistingCliLock(f.root, 'fixture-late-holder'))
    held.push(await locks.acquireExistingCliLock(f.data, 'fixture-late-holder'))
    const { removeDesktopRemovalPrograms } = await import('../desktop-removal-delete.mjs')
    let observations = 0
    t.mock.method(identity, 'inspectProgramReferences', async () => ({ complete: true, incomplete: false,
      processes: ++observations === 1 ? [] : [{ pid: process.pid }], unknown_pids: [] }))
    await assert.rejects(removeDesktopRemovalPrograms({ installRoot: f.root, operationId: f.operationId }), { code: 'CRABOT_DESKTOP_PROGRAM_REFERENCES', stage: 'before-group' })
    assert.equal(observations, 2)
    assert.equal(await fs.readFile(path.join(f.core, 'nested/program.txt'), 'utf8'), 'Core bytes')
    assert.equal(await fs.readFile(path.join(f.data, 'user.txt'), 'utf8'), 'preserved data and runtime bases')
    assert.equal(JSON.parse(await fs.readFile(path.join(f.root, '.desktop-removal.json'))).phase, 'removing')
  } finally { for (const lock of held.reverse()) locks.releaseCliLock(lock) }
})


test('Windows final file ownership is checked again after its byte match', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), locks = await import('../cli-lock.mjs'), held = []
  try {
    held.push(await locks.acquireExistingCliLock(f.root, 'fixture-late-file-owner'))
    held.push(await locks.acquireExistingCliLock(f.data, 'fixture-late-file-owner'))
    const { removeDesktopRemovalPrograms } = await import('../desktop-removal-delete.mjs')
    const target = path.join(f.core, 'nested/program.txt')
    t.mock.method(identity, 'inspectProgramReferences', async () => ({ complete: true, incomplete: false, processes: [], unknown_pids: [] }))
    const open = fs.open, owned = identity.isOwnedFile; let matches = 0, ownershipChanged = false
    t.mock.method(identity, 'isOwnedFile', (file, ...args) => file === target && ownershipChanged ? false : owned(file, ...args))
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await open(...args)
      if (args[0] === target && ++matches === 2) ownershipChanged = true
      return handle
    })
    const result = await removeDesktopRemovalPrograms({ installRoot: f.root, operationId: f.operationId })
    assert.equal(ownershipChanged, true); assert.ok(result.retained.some(value => value.path.endsWith('nested/program.txt')))
    assert.equal(await fs.readFile(target, 'utf8'), 'Core bytes')
    assert.equal(await fs.readFile(path.join(f.data, 'user.txt'), 'utf8'), 'preserved data and runtime bases')
  } finally { for (const lock of held.reverse()) locks.releaseCliLock(lock) }
})

test('verified unrelated protected macOS service no longer blocks proven private program deletion', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t), locks = await import('../cli-lock.mjs'), held = []
  const inspect = identity.inspectProcess, service = { pid: 2147483000, parent: 1, owner: inspect(process.pid).owner,
    started: '100:1', executable: '/usr/libexec/lsd' }
  try {
    held.push(await locks.acquireExistingCliLock(f.root, 'fixture-protected-system'))
    held.push(await locks.acquireExistingCliLock(f.data, 'fixture-protected-system'))
    t.mock.method(identity, 'listProcessIds', () => [service.pid])
    t.mock.method(identity, 'inspectProcess', pid => pid === service.pid ? { ...service } : inspect(pid))
    const observation = { complete: false, incomplete: false, processes: [], unknown_pids: [service.pid],
      unknown_details: [{ pid: service.pid, stage: 'descriptor_details', os_error: 1 }] }
    t.mock.method(identity, 'inspectProgramReferences', async () => observation)
    const { removeDesktopRemovalPrograms } = await import('../desktop-removal-delete.mjs')
    const result = await removeDesktopRemovalPrograms({ installRoot: f.root, operationId: f.operationId })
    assert.ok(result.removed.length >= 7); assert.equal(result.retained.length, 0)
    assert.equal(observation.complete, false); assert.deepEqual(observation.unknown_pids, [service.pid])
    assert.equal(await fs.readFile(path.join(f.data, 'user.txt'), 'utf8'), 'preserved data and runtime bases')
    assert.equal(JSON.parse(await fs.readFile(path.join(f.root, '.desktop-removal.json'))).phase, 'removing')
  } finally { for (const lock of held.reverse()) locks.releaseCliLock(lock) }
})

test('one unchanged destructive admission does not rediscover the installation for every nested reader', async t => {
  const f = await fixture(t), locks = await import('../cli-lock.mjs')
  const held = [await locks.acquireExistingCliLock(f.root, 'fixture-observation'), await locks.acquireExistingCliLock(f.data, 'fixture-observation')]
  t.after(() => { for (const lock of held.reverse()) locks.releaseCliLock(lock) })
  const { captureDesktopRemovalJob } = await import('../desktop-removal-context.mjs')
  const context = await captureDesktopRemovalJob({ installRoot: f.root, operationId: f.operationId })
  context.assertJob()
  const read = fsSync.readFileSync, inspect = identity.inspectProcess
  let discoveryReads = 0, processQueries = 0
  t.mock.method(fsSync, 'readFileSync', (file, ...args) => {
    if (file === path.join(f.root, 'desktop-installation.json')) discoveryReads++
    return read(file, ...args)
  })
  t.mock.method(identity, 'inspectProcess', (...args) => { processQueries++; return inspect(...args) })
  context.assertJob()
  console.log('CRABOT_REMOVAL_ADMISSION_COST ' + JSON.stringify({ installation_reads: discoveryReads, actual_process_queries: processQueries }))
  assert.ok(processQueries > 0, 'Actual process and lock facts remain fresh')
  assert.ok(discoveryReads <= 1, 'Unchanged installation JSON was repeatedly read during one file admission: ' + discoveryReads)
})

for (const mode of ['unchanged-rewrite', 'record-changed', 'in-place-record-changed', 'installation-changed', 'selection-changed', 'runtime-changed', 'permission-changed', 'lock-released', 'ancestor-redirected']) test('warmed removal facts still inspect every current mutation: ' + mode, async t => {
  const f = await fixture(t), locks = await import('../cli-lock.mjs')
  const held = [await locks.acquireExistingCliLock(f.root, 'fixture-freshness'), await locks.acquireExistingCliLock(f.data, 'fixture-freshness')]
  t.after(() => { for (const lock of held.reverse()) locks.releaseCliLock(lock) })
  const { captureDesktopRemovalJob } = await import('../desktop-removal-context.mjs')
  const context = await captureDesktopRemovalJob({ installRoot: f.root, operationId: f.operationId })
  context.assertJob()
  const rewrite = async (name, transform) => {
    const file = path.join(f.root, name), original = JSON.parse(await fs.readFile(file, 'utf8'))
    await privateJson(file, transform(original), true)
  }
  if (mode === 'unchanged-rewrite') await rewrite('.desktop-removal.json', value => value)
  if (mode === 'record-changed') await rewrite('.desktop-removal.json', value => ({ ...value, phase: 'completed' }))
  if (mode === 'in-place-record-changed') {
    const file = path.join(f.root, '.desktop-removal.json'), before = await fs.lstat(file, { bigint: true })
    const text = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, text.replace('\"removing\"', '\"stopping\"'))
    const after = await fs.lstat(file, { bigint: true })
    assert.equal(after.ino, before.ino); assert.equal(after.size, before.size)
  }
  if (mode === 'installation-changed') await rewrite('desktop-installation.json', value => ({ ...value, installation_id: randomUUID() }))
  if (mode === 'selection-changed') await rewrite('current-release.json', value => ({ ...value, gui_id: randomUUID() }))
  if (mode === 'runtime-changed') await fs.writeFile(path.join(f.data, 'instance-runtime.json'), '{}')
  if (mode === 'permission-changed') {
    const file = path.join(f.root, '.desktop-removal.json')
    if (process.platform === 'win32') {
      // Replacing a private file with an ordinary inherited-ACL copy must be seen.
      const text = await fs.readFile(file); await fs.unlink(file); await fs.writeFile(file, text)
    } else await fs.chmod(file, 0o644)
  }
  if (mode === 'lock-released') locks.releaseCliLock(held.pop())
  if (mode === 'ancestor-redirected') {
    const moved = f.temporary + '-moved'
    t.after(() => fs.rm(moved, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }))
    await fs.rename(f.temporary, moved)
    await fs.symlink(moved, f.temporary, process.platform === 'win32' ? 'junction' : 'dir')
  }
  if (mode === 'unchanged-rewrite') context.assertJob()
  else assert.throws(() => context.assertJob())
  assert.equal(await fs.readFile(path.join(f.data, 'user.txt'), 'utf8'), 'preserved data and runtime bases')
})

test('finite many-file removal keeps repeated installation reads bounded and preserves data', { timeout: 60000 }, async t => {
  const locks = await import('../cli-lock.mjs'), { removeDesktopRemovalPrograms } = await import('../desktop-removal-delete.mjs')
  const observations = [], read = fsSync.readFileSync
  t.mock.method(identity, 'inspectProgramReferences', async () => ({ complete: true, incomplete: false, processes: [], unknown_pids: [] }))
  for (const programCount of [64, 128]) {
    const f = await fixture(t, programCount)
    const held = [await locks.acquireExistingCliLock(f.root, 'fixture-cost'), await locks.acquireExistingCliLock(f.data, 'fixture-cost')]
    let discoveryReads = 0
    const reader = t.mock.method(fsSync, 'readFileSync', (file, ...args) => {
      if (file === path.join(f.root, 'desktop-installation.json')) discoveryReads++
      return read(file, ...args)
    })
    try {
      const started = performance.now(), result = await removeDesktopRemovalPrograms({ installRoot: f.root, operationId: f.operationId })
      console.log('CRABOT_REMOVAL_MANY_FILE_COST ' + JSON.stringify({ platform: process.platform, finite_added_files: programCount,
        installation_reads: discoveryReads, elapsed_ms: Math.round(performance.now() - started), resource_observation_substituted: true }))
      assert.equal(result.retained.length, 0); assert.ok(result.removed.length > programCount)
      observations.push(discoveryReads)
      await assert.rejects(fs.lstat(f.core), { code: 'ENOENT' }); await assert.rejects(fs.lstat(f.gui), { code: 'ENOENT' })
      assert.equal(await fs.readFile(path.join(f.data, 'user.txt'), 'utf8'), 'preserved data and runtime bases')
    } finally { reader.mock.restore(); for (const lock of held.reverse()) locks.releaseCliLock(lock) }
  }
  assert.equal(observations[1], observations[0], 'Doubling program files must not double installation JSON parsing')
})

test('generic stopped facts leave the retained target selection policy with their caller', async t => {
  const f = await fixture(t), locks = await import('../cli-lock.mjs')
  const held = [await locks.acquireExistingCliLock(f.root, 'fixture-selection'), await locks.acquireExistingCliLock(f.data, 'fixture-selection')]
  t.after(() => { for (const lock of held.reverse()) locks.releaseCliLock(lock) })
  const { captureDesktopRemovalFacts, captureStoppedDesktopRemoval } = await import('../desktop-removal-context.mjs')
  const facts = await captureDesktopRemovalFacts({ installRoot: f.root, operationId: f.operationId })
  facts.assertIdentity()
  const file = path.join(f.root, 'current-release.json'), selected = JSON.parse(await fs.readFile(file, 'utf8'))
  await privateJson(file, { ...selected, gui_id: randomUUID() }, true)
  facts.assertIdentity() // No source-selection authority is supplied by neutral facts.
  const stopped = await captureStoppedDesktopRemoval({ installRoot: f.root, operationId: f.operationId })
  assert.throws(() => stopped.assertStopped(), { code: 'CRABOT_DESKTOP_REMOVAL' })
})

for (const mode of ['no-targets', 'reappeared-program', 'reappeared-directory']) test('unused-program observation still requires an actual remaining target: ' + mode, async t => {
  const f = await fixture(t), locks = await import('../cli-lock.mjs')
  const held = [await locks.acquireExistingCliLock(f.root, 'fixture-empty-targets'), await locks.acquireExistingCliLock(f.data, 'fixture-empty-targets')]
  t.after(() => { for (const lock of held.reverse()) locks.releaseCliLock(lock) })
  const { removeDesktopRemovalPrograms, assertDesktopRemovalProgramsUnused } = await import('../desktop-removal-delete.mjs')
  const { readDesktopRemovalProof } = await import('../desktop-removal-proof.mjs')
  t.mock.method(identity, 'inspectProgramReferences', async () => ({ complete: true, incomplete: false, processes: [], unknown_pids: [] }))
  const { proof } = await readDesktopRemovalProof(f.root)
  const result = await removeDesktopRemovalPrograms({ installRoot: f.root, operationId: f.operationId })
  assert.equal(result.retained.length, 0)
  if (mode === 'reappeared-program') await fs.writeFile(path.join(f.root, 'bin', f.launcher), 'unknown new file; do not remove')
  if (mode === 'reappeared-directory') await fs.mkdir(f.gui)
  let queries = 0
  t.mock.method(identity, 'inspectProgramReferences', async () => {
    queries++
    return { complete: false, incomplete: true, processes: [], unknown_pids: [process.pid], unknown_details: [] }
  })
  const pending = assertDesktopRemovalProgramsUnused({ installRoot: f.root, proof }, 'fixture-no-targets')
  if (mode === 'no-targets') { await pending; assert.equal(queries, 0) }
  else { await assert.rejects(pending, { code: 'CRABOT_DESKTOP_PROGRAM_REFERENCES' }); assert.equal(queries, 1) }
  assert.equal(await fs.readFile(path.join(f.data, 'user.txt'), 'utf8'), 'preserved data and runtime bases')
})
