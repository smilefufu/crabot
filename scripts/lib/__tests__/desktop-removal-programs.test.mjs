import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import management from '../desktop-management.cjs'
import identity from '../process-identity.cjs'
import { privateJson } from '../desktop-preparation-files.mjs'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const recordFor = bytes => ({ type: 'file', size: Buffer.byteLength(bytes), sha256: digest(bytes), ...(process.platform === 'win32' ? {} : { mode: 0o644 }) })
async function fixture(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-program-audit-')))
  t.after(() => fs.rm(temporary, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }))
  const root = management.ensurePrivateDataRoot(path.join(temporary, 'installation')), data = management.ensurePrivateDataRoot(path.join(root, 'data'))
  const launcher = process.platform === 'win32' ? 'crabot.exe' : 'crabot', launcherBytes = 'inert launcher, never executed'
  const files = { 'nested/program.txt': recordFor('Core bytes'), ['bin/' + launcher]: recordFor(launcherBytes) }
  if (process.platform !== 'win32') files['bin/' + launcher].mode = 0o755
  if (process.platform !== 'win32') files['nested/relative-link'] = { type: 'link', target: 'program.txt' }
  const inventory = JSON.stringify({ schema_version: 1, files }) + '\n'
  const selection = { schema_version: 1, version: '1.2.3', gui_id: randomUUID(), core_id: digest(inventory) }
  const core = path.join(root, 'releases', selection.core_id), gui = path.join(root, 'app/releases', selection.gui_id)
  for (const dir of [path.join(core, 'nested'), path.join(core, 'bin'), gui, path.join(root, 'bin')]) await fs.mkdir(dir, { recursive: true })
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
  let raced = false
  if (['read-race', 'job-race', 'directory-race'].includes(mode)) {
    const open = fs.open
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await open(...args)
      if (args[0] === source) {
        raced = true
        if (mode === 'read-race') await fs.appendFile(source, ' changed while opening')
        if (mode === 'job-race') { const file = path.join(f.root, '.desktop-removal.json'), record = JSON.parse(await fs.readFile(file)); await privateJson(file, { ...record, operation_id: randomUUID() }, true) }
        if (mode === 'directory-race') { const directory = path.dirname(source); await fs.rename(directory, directory + '-old'); await fs.mkdir(directory); await fs.writeFile(source, 'Core bytes') }
      }
      return handle
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
  assert.deepEqual(await fs.readFile(path.join(f.data, 'user.txt')), beforeData); if (mode !== 'job-race') assert.deepEqual(await fs.readFile(path.join(f.root, '.desktop-removal.json')), beforeRecord)
})
