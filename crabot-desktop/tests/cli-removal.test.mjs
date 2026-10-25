import test from 'node:test'
import assert from 'node:assert/strict'
import fsSync, { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const base = '../dist/bootstrap/scripts/lib/'
const management = require(base + 'desktop-management.cjs'), identity = require(base + 'process-identity.cjs')
const locks = await import(base + 'cli-lock.mjs')
const { privateJson } = await import(base + 'desktop-preparation-files.mjs')
const digest = text => createHash('sha256').update(text).digest('hex'), windows = process.platform === 'win32'
const wrapper = '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%~dp0.crabot-desktop-core\\bin\\crabot.exe" %*\r\nexit /b %errorlevel%\r\n'
async function fixture(t, rootName = 'installation') {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-cli-removal-')))
  let held = []
  t.after(async () => { for (const lock of held.reverse()) locks.releaseCliLock(lock); await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) })
  const root = management.ensurePrivateDataRoot(path.join(directory, rootName)), home = management.ensurePrivateDataRoot(path.join(directory, 'home'))
  for (const name of ['app/releases', 'releases', 'bin']) await fs.mkdir(path.join(root, name), { recursive: true })
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), operationId = randomUUID(), id = randomUUID()
  const file = { type: 'file', size: 7, sha256: digest('program'), ...(windows ? {} : { mode: 0o644 }) }
  const inventory = JSON.stringify({ schema_version: 1, files: { 'program.txt': file } }) + '\n'
  const selection = { schema_version: 1, version: '1.2.3', gui_id: randomUUID(), core_id: digest(inventory) }
  const stat = await fs.lstat(root, { bigint: true }), record = { schema_version: 1, installation_id: id, owner: identity.inspectProcess(process.pid).owner,
    install_root: root, root_identity: { dev: String(stat.dev), ino: String(stat.ino) }, paths: { app: 'app/releases', core: 'releases', data: 'data', bin: 'bin' } }
  await privateJson(path.join(root, 'desktop-installation.json'), record); await privateJson(path.join(root, 'current-release.json'), selection)
  const payload = { schema_version: 1, platform: process.platform, arch: process.arch, selection, gui: { 'program.txt': file } }
  const proof = { schema_version: 1, installation_id: id, operation_id: operationId, source_selection: selection, payload,
    core: { release: JSON.stringify({ schema_version: 1, version: selection.version, platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false, inventory_sha256: selection.core_id }) + '\n',
      inventory, host: JSON.stringify({ schema_version: 2, platform: process.platform, arch: process.arch }) + '\n' } }
  const job = management.ensurePrivateDataRoot(path.join(management.ensurePrivateDataRoot(path.join(root, 'app/removals')), operationId))
  await privateJson(path.join(job, 'proof.json'), proof)
  const removal = { schema_version: 1, installation_id: id, operation_id: operationId, source_selection: selection, phase: 'removing', proof_sha256: digest(JSON.stringify(proof) + '\n') }
  await privateJson(path.join(root, '.desktop-removal.json'), removal)
  await fs.writeFile(path.join(data, 'user.txt'), 'data and dependencies preserved')
  await fs.writeFile(path.join(home, '.zshrc'), 'user shell settings preserved')
  const env = { LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming') }
  const prefix = windows ? management.ensurePrivateDataRoot(path.join(env.LOCALAPPDATA, 'Crabot/cli')) : path.join(home, '.local/bin')
  if (!windows) await fs.mkdir(prefix, { recursive: true, mode: 0o755 })
  const metadata = path.join(prefix, '.crabot-desktop-cli.json'), entry = path.join(prefix, windows ? 'crabot.cmd' : 'crabot'), pointer = path.join(prefix, '.crabot-desktop-core')
  await privateJson(metadata, { schema_version: 2, install_root: root })
  if (windows) { await fs.symlink(root, pointer, 'junction'); await fs.writeFile(entry, wrapper) }
  else await fs.symlink(path.join(root, 'bin/crabot'), entry)
  const { integrationRoot } = await import('../dist/installation-entries.js')
  const locator = path.join(management.ensurePrivateDataRoot(integrationRoot(home, process.platform, env)), 'installation.json')
  await privateJson(locator, { schema_version: 1, owner: record.owner, install_root: root, installation_id: id })
  held = [await locks.acquireExistingCliLock(root, 'fixture-removal'), await locks.acquireExistingCliLock(data, 'fixture-removal')]
  return { root, home, data, operationId, env, prefix, metadata, entry, pointer, removal, held, locator }
}
for (const mode of ['owned', 'partial', 'missing-prefix', 'foreign', 'changed-command', 'unknown-schema', 'changed-record', 'redirected-prefix', 'missing-lock', 'wrong-operation', 'before-removing', 'running', 'late-change', 'lost-reply', 'lost-metadata-reply', 'grow-during-snapshot', 'workspace-pending', 'version-pending', 'module-pending', 'replaced-lock', 'lost-lock-during-check', 'invalid-utf8', 'foreign-locator', 'moved-data-during-check']) test('only the current removal job may clear its owned CLI entry: ' + mode, { skip: windows && ['replaced-lock', 'moved-data-during-check'].includes(mode) }, async t => {
  const f = await fixture(t, mode === 'invalid-utf8' ? 'installation-\uFFFD' : undefined), { removeDesktopCliEntries } = await import('../dist/installation-removal.js')
  const input = { installRoot: f.root, operationId: f.operationId, home: f.home, env: f.env }
  if (mode === 'partial') await fs.unlink(f.entry)
  if (mode === 'missing-prefix') await fs.rm(f.prefix, { recursive: true })
  if (mode === 'invalid-utf8') {
    const bytes = await fs.readFile(f.metadata), offset = bytes.indexOf(Buffer.from('\uFFFD'))
    assert.ok(offset >= 0)
    const corrupted = Buffer.concat([bytes.subarray(0, offset), Buffer.from([255]), bytes.subarray(offset + 3)])
    assert.equal(corrupted.toString('utf8'), bytes.toString('utf8')); await fs.writeFile(f.metadata, corrupted)
  }
  if (mode === 'foreign-locator') await privateJson(f.locator, { schema_version: 1, owner: identity.inspectProcess(process.pid).owner, install_root: f.home, installation_id: randomUUID() }, true)
  const locatorBefore = await fs.readFile(f.locator)
  if (mode === 'foreign') await privateJson(f.metadata, { schema_version: 2, install_root: f.home }, true)
  if (mode === 'unknown-schema') await privateJson(f.metadata, { schema_version: 99, install_root: f.root }, true)
  if (mode === 'changed-record') await fs.appendFile(f.metadata, ' ')
  if (mode === 'changed-command') {
    if (windows) await fs.appendFile(f.entry, 'rem user customization\r\n')
    else { await fs.unlink(f.entry); await fs.symlink(path.join(f.home, 'custom-command'), f.entry) }
  }
  if (mode === 'redirected-prefix') { await fs.rename(f.prefix, f.prefix + '-original'); await fs.symlink(f.prefix + '-original', f.prefix, windows ? 'junction' : 'dir') }
  if (mode === 'missing-lock') locks.releaseCliLock(f.held.pop())
  if (mode === 'wrong-operation') input.operationId = randomUUID()
  if (mode === 'before-removing') await privateJson(path.join(f.root, '.desktop-removal.json'), { ...f.removal, phase: 'stopping' }, true)
  if (mode === 'running') await fs.writeFile(path.join(f.data, 'mm.pid'), String(process.pid))
  if (mode === 'workspace-pending') { await fs.mkdir(path.join(f.data, 'workspace-control')); await fs.writeFile(path.join(f.data, 'workspace-control/relocation.json'), 'pending') }
  if (mode === 'version-pending') await fs.writeFile(path.join(f.data, 'desktop-maintenance.json'), 'pending')
  if (mode === 'module-pending') { await fs.mkdir(path.join(f.data, 'module-runtime-registry/records'), { recursive: true }); await fs.writeFile(path.join(f.data, 'module-runtime-registry/records/unsettled.json'), '{}') }
  if (mode === 'replaced-lock') { const file = path.join(f.root, 'cli.lock'), raw = await fs.readFile(file); await fs.rename(file, file + '.original'); await fs.writeFile(file, raw) }
  const refused = ['missing-lock', 'wrong-operation', 'before-removing', 'running', 'workspace-pending', 'version-pending', 'module-pending', 'replaced-lock', 'lost-lock-during-check', 'moved-data-during-check'].includes(mode)
  const retained = ['foreign', 'changed-command', 'unknown-schema', 'changed-record', 'redirected-prefix', 'invalid-utf8', 'foreign-locator'].includes(mode)
  let unboundedReads = 0, injected = false
  if (mode === 'moved-data-during-check') {
    const original = fs.lstat; let checks = 0
    t.mock.method(fs, 'lstat', async (...args) => {
      const value = await original(...args)
      if (args[0] === f.entry && ++checks === 6) {
        injected = true; await fs.rename(f.data, f.data + '-original'); await fs.mkdir(f.data, { mode: 0o700 })
        await fs.rename(path.join(f.data + '-original', 'cli.lock'), path.join(f.data, 'cli.lock'))
        assert.equal(locks.hasInheritedCliLock(f.data, locks.cliLockToken(f.held[1])), true)
      }
      return value
    })
  }
  if (mode === 'lost-lock-during-check') {
    const original = fs.lstat; let checks = 0
    t.mock.method(fs, 'lstat', async (...args) => {
      const value = await original(...args)
      if (args[0] === f.entry && ++checks === 6) { injected = true; locks.releaseCliLock(f.held.pop()) }
      return value
    })
  }
  if (mode === 'late-change') {
    const original = fsSync.readdirSync; let checks = 0
    t.mock.method(fsSync, 'readdirSync', (...args) => {
      if (args[0] === path.join(f.data, 'module-runtime-registry/records') && ++checks === 2) {
        injected = true
        if (windows) fsSync.appendFileSync(f.entry, 'rem changed after preflight\r\n')
        else { fsSync.unlinkSync(f.entry); fsSync.symlinkSync(path.join(f.home, 'late-custom-command'), f.entry) }
      }
      return original(...args)
    })
  }
  const before = await fs.readFile(f.metadata, 'utf8').catch(() => null)
  if (['lost-reply', 'lost-metadata-reply'].includes(mode)) {
    const original = fs.unlink, target = mode === 'lost-reply' ? f.entry : f.metadata
    const mocked = t.mock.method(fs, 'unlink', async file => {
      const result = await original(file)
      if (file === target) { injected = true; throw Object.assign(new Error('fixture lost unlink reply'), { code: 'EIO' }) }
      return result
    })
    await assert.rejects(removeDesktopCliEntries(input), { code: 'EIO' }); mocked.mock.restore()
    assert.equal(injected, true)
  }
  if (mode === 'grow-during-snapshot') {
    const originalStat = fs.lstat, originalRead = fs.readFile
    t.mock.method(fs, 'lstat', async (...args) => {
      const value = await originalStat(...args)
      if (args[0] === f.metadata && !injected) { injected = true; await fs.appendFile(f.metadata, 'x'.repeat(131072)) }
      return value
    })
    t.mock.method(fs, 'readFile', async (...args) => { if (args[0] === f.metadata) unboundedReads++; return originalRead(...args) })
  }
  if (refused) await assert.rejects(removeDesktopCliEntries(input), { code: 'CRABOT_DESKTOP_REMOVAL' })
  else {
    const result = await removeDesktopCliEntries(input)
    assert.equal(result.retained, retained || mode === 'late-change' || mode === 'grow-during-snapshot')
    if (!retained && mode !== 'late-change' && mode !== 'grow-during-snapshot') {
      await assert.rejects(fs.lstat(f.entry), { code: 'ENOENT' }); await assert.rejects(fs.lstat(f.metadata), { code: 'ENOENT' })
      if (windows) await assert.rejects(fs.lstat(f.pointer), { code: 'ENOENT' })
      assert.equal((await removeDesktopCliEntries(input)).retained, false)
    }
  }
  if (mode === 'moved-data-during-check') { assert.equal(injected, true); assert.ok(await fs.lstat(f.entry)) }
  if (mode === 'lost-lock-during-check') { assert.equal(injected, true); assert.ok(await fs.lstat(f.entry)) }
  if (mode === 'missing-prefix') await assert.rejects(fs.lstat(f.prefix), { code: 'ENOENT' })
  if (mode === 'late-change') { assert.equal(injected, true); assert.equal(await fs.readFile(f.metadata, 'utf8'), before) }
  if (mode === 'grow-during-snapshot') { assert.equal(injected, true); assert.equal(unboundedReads, 0) }
  if (refused || retained) assert.equal(await fs.readFile(f.metadata, 'utf8'), before)
  assert.equal(await fs.readFile(path.join(mode === 'moved-data-during-check' ? f.data + '-original' : f.data, 'user.txt'), 'utf8'), 'data and dependencies preserved')
  assert.deepEqual(await fs.readFile(f.locator), locatorBefore)
  assert.equal(await fs.readFile(path.join(f.home, '.zshrc'), 'utf8'), 'user shell settings preserved')
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, '.desktop-removal.json'), 'utf8')), mode === 'before-removing' ? { ...f.removal, phase: 'stopping' } : f.removal)
})


for (const mode of ['owned', 'custom-menu', 'foreign-locator', 'wrong-operation', 'missing-lock', 'before-removing', 'running', 'lost-reply', 'lost-lock-during-check', 'changed-phase-during-check']) test('removal menu cleanup uses its job with missing Core and retains discovery: ' + mode, async t => {
  const f = await fixture(t), api = await import('../dist/installation-removal.js')
  assert.equal(typeof api.removeDesktopMenuEntry, 'function')
  const { desktopApplicationEntry } = await import('../dist/installation-entries.js')
  const guiRoot = path.join(f.root, 'app/releases', f.removal.source_selection.gui_id)
  const executable = path.join(guiRoot, windows ? 'Crabot.exe' : 'crabot-desktop')
  const entry = process.platform === 'darwin' ? path.join(f.home, 'Applications/Crabot.app') : windows
    ? path.join(f.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Crabot.lnk') : path.join(f.home, '.local/share/applications/crabot.desktop')
  await fs.mkdir(path.dirname(entry), { recursive: true })
  const shortcut = { target: executable, args: '', cwd: guiRoot, icon: executable, iconIndex: 0, description: 'Crabot', appUserModelId: 'com.crabot.desktop' }
  if (process.platform === 'darwin') await fs.symlink(path.join(guiRoot, 'Crabot.app'), entry)
  else await fs.writeFile(entry, windows ? 'inert shortcut API fixture' : desktopApplicationEntry(executable, path.join(guiRoot, 'resources/crabot.png'), f.removal.installation_id))
  const input = { installRoot: f.root, operationId: f.operationId, home: f.home, env: f.env,
    shell: { readShortcutLink: () => shortcut }, unregisterMac: async application => assert.equal(application, path.join(guiRoot, 'Crabot.app')) }
  if (mode === 'custom-menu') {
    if (process.platform === 'darwin') { await fs.unlink(entry); await fs.symlink(path.join(f.home, 'custom.app'), entry) }
    else if (windows) shortcut.args = '--custom'
    else await fs.writeFile(entry, 'user menu')
  }
  if (mode === 'foreign-locator') await privateJson(f.locator, { schema_version: 1, owner: identity.inspectProcess(process.pid).owner, install_root: f.home, installation_id: randomUUID() }, true)
  if (mode === 'wrong-operation') input.operationId = randomUUID()
  if (mode === 'missing-lock') locks.releaseCliLock(f.held.pop())
  if (mode === 'before-removing') await privateJson(path.join(f.root, '.desktop-removal.json'), { ...f.removal, phase: 'stopping' }, true)
  if (mode === 'running') await fs.writeFile(path.join(f.data, 'mm.pid'), String(process.pid))
  const locator = await fs.readFile(f.locator), cli = await fs.readFile(f.metadata)
  let injected = false
  if (['lost-lock-during-check', 'changed-phase-during-check'].includes(mode)) {
    const lstat = fs.lstat; let checks = 0
    t.mock.method(fs, 'lstat', async (...args) => {
      const value = await lstat(...args)
      if (args[0] === entry && ++checks === 6) {
        injected = true
        if (mode === 'lost-lock-during-check') locks.releaseCliLock(f.held.pop())
        else await privateJson(path.join(f.root, '.desktop-removal.json'), { ...f.removal, phase: 'completed' }, true)
      }
      return value
    })
  }
  if (mode === 'lost-reply') {
    const unlink = fs.unlink, fault = t.mock.method(fs, 'unlink', async file => {
      await unlink(file)
      if (file === entry) throw Object.assign(new Error('menu unlink reply lost'), { code: 'EIO' })
    })
    await assert.rejects(api.removeDesktopMenuEntry(input), { code: 'EIO' }); fault.mock.restore()
  }
  if (['wrong-operation', 'missing-lock', 'before-removing', 'running', 'lost-lock-during-check', 'changed-phase-during-check'].includes(mode)) await assert.rejects(api.removeDesktopMenuEntry(input), { code: 'CRABOT_DESKTOP_REMOVAL' })
  else if (['custom-menu', 'foreign-locator'].includes(mode)) await assert.rejects(api.removeDesktopMenuEntry(input), { code: 'CRABOT_INSTALL_REGISTRATION' })
  else {
    await api.removeDesktopMenuEntry(input); await api.removeDesktopMenuEntry(input)
    await assert.rejects(fs.lstat(entry), { code: 'ENOENT' })
  }
  if (['lost-lock-during-check', 'changed-phase-during-check'].includes(mode)) assert.equal(injected, true)
  if (!['owned', 'lost-reply'].includes(mode)) assert.ok(await fs.lstat(entry))
  assert.deepEqual(await fs.readFile(f.locator), locator); assert.deepEqual(await fs.readFile(f.metadata), cli)
  assert.equal(await fs.readFile(path.join(f.data, 'user.txt'), 'utf8'), 'data and dependencies preserved')
  await assert.rejects(fs.lstat(path.join(f.root, 'releases', f.removal.source_selection.core_id)), { code: 'ENOENT' })
})


for (const mode of ['owned', 'xdg-config', 'absent', 'missing-directory', 'custom', 'other-executable', 'disabled', 'permissions', 'symlink', 'redirected-parent', 'foreign-locator', 'wrong-operation', 'missing-lock', 'before-removing', 'running', 'preparation', 'late-change', 'late-lock', 'late-parent', 'late-reappearance', 'lost-reply', 'reappeared']) test('Ubuntu autostart byte cleanup keeps the original removal protection: ' + mode, { skip: windows && ['permissions', 'symlink'].includes(mode) }, async t => {
  const f = await fixture(t), api = await import('../dist/installation-removal.js')
  const { LoginStartup, ubuntuLoginStartupEntry } = await import('../dist/login-startup.js')
  const configHome = path.join(f.home, mode === 'xdg-config' ? 'custom-config' : '.config'), entry = path.join(configHome, 'autostart/crabot.desktop')
  const executable = path.join(f.root, 'app/releases', f.removal.source_selection.gui_id, 'crabot-desktop')
  const startup = new LoginStartup({ platform: 'linux', packaged: true, executable, configHome,
    app: { getLoginItemSettings() { throw new Error('No host OS login API in a file-only fixture') }, setLoginItemSettings() { throw new Error('No host OS login mutation') } } })
  await startup.set(true)
  const input = { installRoot: f.root, operationId: f.operationId, home: f.home, env: { ...f.env, ...(mode === 'xdg-config' ? { XDG_CONFIG_HOME: configHome } : {}) } }
  if (mode === 'absent') await fs.unlink(entry)
  if (mode === 'missing-directory') await fs.rm(path.dirname(entry), { recursive: true })
  if (mode === 'custom') await fs.appendFile(entry, 'X-Custom=keep\n')
  if (mode === 'other-executable') {
    const previous = await fs.readFile(entry, 'utf8'), replacement = ubuntuLoginStartupEntry(path.join(f.home, 'other-program'))
    assert.notEqual(previous, replacement)
    await fs.writeFile(entry, replacement)
  }
  if (mode === 'disabled') await fs.appendFile(entry, 'Hidden=true\n')
  if (mode === 'permissions') await fs.chmod(entry, 0o644)
  if (mode === 'symlink') { await fs.rename(entry, entry + '.original'); await fs.symlink(entry + '.original', entry) }
  if (mode === 'redirected-parent') { await fs.rename(path.dirname(entry), path.dirname(entry) + '.original'); await fs.symlink(path.dirname(entry) + '.original', path.dirname(entry), windows ? 'junction' : 'dir') }
  if (mode === 'foreign-locator') await privateJson(f.locator, { schema_version: 1, owner: identity.inspectProcess(process.pid).owner, install_root: f.home, installation_id: randomUUID() }, true)
  if (mode === 'wrong-operation') input.operationId = randomUUID()
  if (mode === 'missing-lock') locks.releaseCliLock(f.held.pop())
  if (mode === 'before-removing') await privateJson(path.join(f.root, '.desktop-removal.json'), { ...f.removal, phase: 'stopping' }, true)
  if (mode === 'running') await fs.writeFile(path.join(f.data, 'mm.pid'), String(process.pid))
  if (mode === 'preparation') await privateJson(path.join(f.root, '.desktop-installing.json'), { schema_version: 1, id: randomUUID(), installation_id: f.removal.installation_id, selection: f.removal.source_selection, phase: 'prepared', payload_sha256: '0'.repeat(64) })
  const before = await fs.readFile(entry).catch(() => null), marker = await fs.readFile(path.join(f.root, '.desktop-removal.json')), locator = await fs.readFile(f.locator)
  const { readInstallationLocator } = await import('../dist/installation-entries.js')
  assert.deepEqual(await readInstallationLocator(f.home, process.platform, input.env), JSON.parse(locator))
  let injected = false
  if (['late-change', 'late-lock', 'late-parent'].includes(mode)) {
    const stat = fs.lstat; let reads = 0
    t.mock.method(fs, 'lstat', async (...args) => {
      const value = await stat(...args)
      if (args[0] === entry && ++reads === 4) {
        injected = true
        if (mode === 'late-change') await fs.appendFile(entry, 'X-Late=keep\n')
        else if (mode === 'late-lock') locks.releaseCliLock(f.held.pop())
        else { await fs.rename(path.dirname(entry), path.dirname(entry) + '.original'); await fs.symlink(path.dirname(entry) + '.original', path.dirname(entry), windows ? 'junction' : 'dir') }
      }
      return value
    })
  }
  if (mode === 'lost-reply') {
    const unlink = fsSync.unlinkSync, fault = t.mock.method(fsSync, 'unlinkSync', file => { const value = unlink(file); if (file === entry) { injected = true; throw Object.assign(new Error('Lost autostart deletion reply'), { code: 'EIO' }) }; return value })
    await assert.rejects(api.removeUbuntuAutostartEntry(input), { code: 'EIO' }); fault.mock.restore()
    assert.equal(injected, true)
  }
  if (mode === 'late-reappearance') {
    const open = fs.open
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await open(...args)
      if (args[0] === path.dirname(entry) && process.platform !== 'win32') {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => { await sync(); injected = true; await fs.writeFile(entry, 'late user replacement') }
      }
      return handle
    })
    if (windows) {
      const unlink = fsSync.unlinkSync
      t.mock.method(fsSync, 'unlinkSync', file => { const result = unlink(file); if (file === entry) { injected = true; fsSync.writeFileSync(entry, 'late user replacement') }; return result })
    }
  }
  const refused = ['wrong-operation', 'missing-lock', 'before-removing', 'running', 'preparation', 'late-lock'].includes(mode)
  const retained = ['custom', 'other-executable', 'disabled', 'permissions', 'symlink', 'redirected-parent', 'foreign-locator', 'late-change', 'late-parent', 'late-reappearance'].includes(mode)
  if (refused) await assert.rejects(api.removeUbuntuAutostartEntry(input), { code: 'CRABOT_DESKTOP_REMOVAL' })
  else if (retained) await assert.rejects(api.removeUbuntuAutostartEntry(input), { code: 'CRABOT_INSTALL_REGISTRATION' })
  else {
    await api.removeUbuntuAutostartEntry(input)
    await assert.rejects(fs.lstat(entry), { code: 'ENOENT' })
    if (mode === 'reappeared') { await fs.writeFile(entry, 'user replacement'); await assert.rejects(api.removeUbuntuAutostartEntry(input), { code: 'CRABOT_INSTALL_REGISTRATION' }); assert.equal(await fs.readFile(entry, 'utf8'), 'user replacement') }
    else await api.removeUbuntuAutostartEntry(input)
  }
  if (['late-change', 'late-lock', 'late-parent'].includes(mode)) assert.equal(injected, true)
  if (mode === 'missing-directory') await assert.rejects(fs.lstat(path.dirname(entry)), { code: 'ENOENT' })
  if (mode === 'late-reappearance') { assert.equal(injected, true); assert.equal(await fs.readFile(entry, 'utf8'), 'late user replacement') }
  if ((refused || retained) && !['late-change', 'late-reappearance'].includes(mode)) assert.deepEqual(await fs.readFile(entry), before)
  assert.deepEqual(await fs.readFile(path.join(f.root, '.desktop-removal.json')), marker)
  assert.deepEqual(await fs.readFile(f.locator), locator)
  assert.equal(await fs.readFile(path.join(f.data, 'user.txt'), 'utf8'), 'data and dependencies preserved')
  assert.ok(await fs.lstat(f.entry)); assert.ok(await fs.lstat(f.metadata))
})


for (const mode of ['owned', 'absent', 'custom', 'foreign', 'foreign-locator', 'wrong-operation', 'missing-lock', 'before-removing', 'running', 'preparation', 'missing-capability', 'lost-reply', 'late-reappearance', 'changed-phase']) test('Windows login command removal requires the same actual stopped job: ' + mode, async t => {
  const f = await fixture(t), api = await import('../dist/installation-removal.js')
  const expected = path.join(f.root, 'app/releases', f.removal.source_selection.gui_id, 'Crabot.exe')
  const input = { installRoot: f.root, operationId: f.operationId, home: f.home, env: f.env }
  if (mode === 'foreign-locator') await privateJson(f.locator, { schema_version: 1, owner: identity.inspectProcess(process.pid).owner, install_root: f.home, installation_id: randomUUID() }, true)
  if (mode === 'wrong-operation') input.operationId = randomUUID()
  if (mode === 'missing-lock') locks.releaseCliLock(f.held.pop())
  if (mode === 'before-removing') await privateJson(path.join(f.root, '.desktop-removal.json'), { ...f.removal, phase: 'stopping' }, true)
  if (mode === 'running') await fs.writeFile(path.join(f.data, 'mm.pid'), String(process.pid))
  if (mode === 'preparation') await privateJson(path.join(f.root, '.desktop-installing.json'), { schema_version: 1, id: randomUUID(), installation_id: f.removal.installation_id, selection: f.removal.source_selection, phase: 'prepared', payload_sha256: '0'.repeat(64) })
  const original = Object.getOwnPropertyDescriptor(identity, 'removeDesktopLoginStartup'), inspect = Object.getOwnPropertyDescriptor(identity, 'inspectDesktopLoginStartup')
  t.after(() => { for (const [name, descriptor] of [['removeDesktopLoginStartup', original], ['inspectDesktopLoginStartup', inspect]]) { if (descriptor) Object.defineProperty(identity, name, descriptor); else delete identity[name] } })
  let command = mode === 'absent' ? 'absent' : mode === 'custom' ? 'custom' : mode === 'foreign' ? 'different' : 'background', calls = 0
  Object.defineProperty(identity, 'inspectDesktopLoginStartup', { configurable: true, writable: true, value: program => { assert.equal(program, expected); return command } })
  Object.defineProperty(identity, 'removeDesktopLoginStartup', { configurable: true, writable: true, value: mode === 'missing-capability' ? undefined : program => {
    calls++; assert.equal(program, expected)
    for (const root of [f.root, f.data]) assert.equal(locks.hasInheritedCliLock(root, locks.cliLockToken(path.join(root, 'cli.lock'))), true)
    if (['custom', 'different'].includes(command)) throw Object.assign(new Error('Native fixture retains unknown command'), { code: 'CRABOT_INSTALL_REGISTRATION' })
    command = 'absent'
    if (mode === 'lost-reply' && calls === 1) throw Object.assign(new Error('Native reply lost'), { code: 'EIO' })
    if (mode === 'late-reappearance') command = 'different'
    if (mode === 'changed-phase') fsSync.writeFileSync(path.join(f.root, '.desktop-removal.json'), JSON.stringify({ ...f.removal, phase: 'completed' }) + '\n')
    return true
  } })
  const locator = await fs.readFile(f.locator), cli = await fs.readFile(f.metadata)
  if (['wrong-operation', 'missing-lock', 'before-removing', 'running', 'preparation', 'changed-phase'].includes(mode)) await assert.rejects(api.removeWindowsLoginStartupEntry(input), { code: 'CRABOT_DESKTOP_REMOVAL' })
  else if (['custom', 'foreign', 'foreign-locator', 'missing-capability', 'late-reappearance'].includes(mode)) await assert.rejects(api.removeWindowsLoginStartupEntry(input), { code: 'CRABOT_INSTALL_REGISTRATION' })
  else {
    if (mode === 'lost-reply') await assert.rejects(api.removeWindowsLoginStartupEntry(input), { code: 'EIO' })
    await api.removeWindowsLoginStartupEntry(input); await api.removeWindowsLoginStartupEntry(input)
    assert.equal(command, 'absent')
  }
  if (['wrong-operation', 'missing-lock', 'before-removing', 'running', 'preparation', 'foreign-locator', 'missing-capability'].includes(mode)) assert.equal(calls, 0)
  if (mode === 'custom') assert.equal(command, 'custom')
  if (['foreign', 'late-reappearance'].includes(mode)) assert.equal(command, 'different')
  assert.deepEqual(await fs.readFile(f.locator), locator); assert.deepEqual(await fs.readFile(f.metadata), cli)
  assert.equal(await fs.readFile(path.join(f.data, 'user.txt'), 'utf8'), 'data and dependencies preserved')
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, '.desktop-removal.json'), 'utf8')), { ...f.removal, phase: mode === 'before-removing' ? 'stopping' : mode === 'changed-phase' ? 'completed' : 'removing' })
})
