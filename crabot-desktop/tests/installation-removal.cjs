// Actual Electron file/shortcut APIs inside a fresh private HOME. Program bytes
// below are inert fixtures; no Core, service, login item or real menu is used.
const { app, shell } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { randomUUID, createHash } = require('node:crypto')
const identity = require('../dist/bootstrap/scripts/lib/process-identity.cjs')
const management = require('../dist/bootstrap/scripts/lib/desktop-management.cjs')
const windows = process.platform === 'win32'
app.setName('Crabot Entry Removal Fixture')
app.setPath('userData', path.join(process.argv[2], 'profile')); app.setPath('sessionData', path.join(process.argv[2], 'profile'))
const timer = setTimeout(() => app.exit(2), 25000)
void app.whenReady().then(async () => {
  const parent = await fs.realpath(process.argv[2]), root = management.ensurePrivateDataRoot(path.join(parent, '整体 安装'))
  const home = management.ensurePrivateDataRoot(path.join(parent, '用户')), id = randomUUID(), guiId = randomUUID()
  const digest = text => createHash('sha256').update(text).digest('hex')
  const file = { type: 'file', size: 7, sha256: digest('program'), ...(windows ? {} : { mode: 0o644 }) }
  const inventory = JSON.stringify({ schema_version: 1, files: { 'program.txt': file } }) + '\n', coreId = digest(inventory)
  for (const name of ['app/releases', 'releases', 'bin']) await fs.mkdir(path.join(root, name), { recursive: true })
  management.ensurePrivateDataRoot(path.join(root, 'data'))
  const stat = await fs.lstat(root, { bigint: true }), selection = { schema_version: 1, version: '1.2.3', gui_id: guiId, core_id: coreId }
  const record = { schema_version: 1, installation_id: id, owner: identity.inspectProcess(process.pid).owner,
    install_root: root, root_identity: { dev: String(stat.dev), ino: String(stat.ino) }, paths: { app: 'app/releases', core: 'releases', data: 'data', bin: 'bin' } }
  const privateJson = async (file, value) => {
    const text = JSON.stringify(value) + '\n'
    if (windows) identity.writePrivateFile(file, text); else await fs.writeFile(file, text, { mode: 0o600 })
  }
  await privateJson(path.join(root, 'desktop-installation.json'), record); await privateJson(path.join(root, 'current-release.json'), selection)
  const guiRoot = path.join(root, 'app/releases', guiId), coreRoot = path.join(root, 'releases', coreId)
  const resources = path.join(guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources' : 'resources')
  const executable = path.join(guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : windows ? 'Crabot.exe' : 'crabot-desktop')
  await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.mkdir(resources, { recursive: true }); await fs.mkdir(coreRoot)
  await fs.writeFile(executable, 'inert GUI fixture, never executed')
  await privateJson(path.join(resources, 'desktop-release.json'), selection)
  await privateJson(path.join(coreRoot, 'core-release.json'), { schema_version: 1, version: selection.version, inventory_sha256: coreId, platform: process.platform, arch: process.arch })
  const prepared = { installRoot: root, installation_id: id, guiRoot, coreRoot, selection }
  const env = { APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share') }
  const { registerInstallationEntries, integrationRoot } = await import(pathToFileURL(path.resolve(__dirname, '../dist/installation-entries.js')).href)
  const { removeInstallationEntries, removeDesktopMenuEntry, removeDesktopInstallationEntries } = await import(pathToFileURL(path.resolve(__dirname, '../dist/installation-removal.js')).href)
  const sentinel = path.join(root, 'data', 'preserved.txt'); await fs.writeFile(sentinel, 'business dependencies and workspace stay')
  let stops = 0, unregisters = 0
  const options = { home, platform: process.platform, env, shell, registerMac: async () => {},
    verifyStopped: async () => { stops++ }, unregisterMac: async application => { assert.equal(application, path.join(guiRoot, 'Crabot.app')); unregisters++ } }
  await registerInstallationEntries(prepared, options)
  const locator = path.join(integrationRoot(home, process.platform, env), 'installation.json')
  const entry = windows ? path.join(env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Crabot.lnk') : process.platform === 'darwin'
    ? path.join(home, 'Applications/Crabot.app') : path.join(env.XDG_DATA_HOME, 'applications/crabot.desktop')
  if (windows) {
    assert.equal(shell.writeShortcutLink(entry, 'update', { args: '--custom' }), true)
    await assert.rejects(removeInstallationEntries(prepared, options), { code: 'CRABOT_INSTALL_REGISTRATION' })
    assert.equal(shell.readShortcutLink(entry).args, '--custom'); assert.ok(await fs.stat(locator))
    assert.equal(shell.writeShortcutLink(entry, 'update', { args: '' }), true)
  }
  await removeInstallationEntries(prepared, options); await removeInstallationEntries(prepared, options)
  await assert.rejects(fs.lstat(entry), { code: 'ENOENT' }); await assert.rejects(fs.lstat(locator), { code: 'ENOENT' })
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'business dependencies and workspace stay')
  assert.ok(await fs.stat(executable)); assert.ok(await fs.stat(path.join(root, 'current-release.json')))
  assert.ok(stops >= 4); assert.equal(unregisters, process.platform === 'darwin' ? 2 : 0)
  console.log('CRABOT_INSTALLATION_REMOVAL ' + JSON.stringify({ platform: process.platform, owned_entries_removed: true, data_and_programs_preserved: true,
    actual_windows_shortcut: windows, real_user_menu_changed: false, login_items_changed: false, business_mm_started: false }))
  // Separate removal-job role, with actual shortcut APIs and missing inert Core.
  // Preserve discovery; the fixture never invokes real LaunchServices or login APIs.
  await registerInstallationEntries(prepared, options)
  const operationId = randomUUID(), proof = { schema_version: 1, installation_id: id, operation_id: operationId, source_selection: selection,
    payload: { schema_version: 1, platform: process.platform, arch: process.arch, selection, gui: { 'program.txt': file } },
    core: { release: JSON.stringify({ schema_version: 1, version: selection.version, platform: process.platform, arch: process.arch,
      commit: '1'.repeat(40), source_dirty: false, inventory_sha256: coreId }) + '\n', inventory,
      host: JSON.stringify({ schema_version: 2, platform: process.platform, arch: process.arch }) + '\n' } }
  const job = management.ensurePrivateDataRoot(path.join(management.ensurePrivateDataRoot(path.join(root, 'app/removals')), operationId))
  await privateJson(path.join(job, 'proof.json'), proof)
  const fence = { schema_version: 1, installation_id: id, operation_id: operationId, source_selection: selection, phase: 'removing', proof_sha256: digest(JSON.stringify(proof) + '\n') }
  await privateJson(path.join(root, '.desktop-removal.json'), fence)
  await fs.rm(coreRoot, { recursive: true })
  const input = { installRoot: root, operationId, home, env, shell, unregisterMac: options.unregisterMac }
  await assert.rejects(removeDesktopMenuEntry(input), { code: 'CRABOT_DESKTOP_REMOVAL' })
  await assert.rejects(removeDesktopInstallationEntries(input), { code: 'CRABOT_DESKTOP_REMOVAL' })
  const locks = await import(pathToFileURL(path.resolve(__dirname, '../dist/bootstrap/scripts/lib/cli-lock.mjs')).href)
  const held = []
  try {
    held.push(await locks.acquireExistingCliLock(root, 'fixture-menu-removal'))
    held.push(await locks.acquireExistingCliLock(path.join(root, 'data'), 'fixture-menu-removal'))
    if (windows) {
      assert.equal(shell.writeShortcutLink(entry, 'update', { args: '--custom' }), true)
      await assert.rejects(removeDesktopMenuEntry(input), { code: 'CRABOT_INSTALL_REGISTRATION' })
      assert.equal(shell.readShortcutLink(entry).args, '--custom'); assert.ok(await fs.stat(locator))
      assert.equal(shell.writeShortcutLink(entry, 'update', { args: '' }), true)
    }
    await removeDesktopMenuEntry(input); await removeDesktopMenuEntry(input)
    await assert.rejects(fs.lstat(entry), { code: 'ENOENT' }); assert.ok(await fs.stat(locator))
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, '.desktop-removal.json'), 'utf8')), fence)
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'business dependencies and workspace stay'); assert.ok(await fs.stat(executable))
    console.log('CRABOT_REMOVAL_MENU_JOB ' + JSON.stringify({ platform: process.platform, core_missing: true, owned_menu_removed: true,
      discovery_preserved: true, actual_windows_shortcut: windows, real_user_menu_changed: false, business_mm_started: false }))
    const originalLocator = JSON.parse(await fs.readFile(locator, 'utf8'))
    await fs.unlink(locator)
    await privateJson(locator, { ...originalLocator, install_root: path.join(parent, 'other') })
    await assert.rejects(removeDesktopInstallationEntries(input), { code: 'CRABOT_INSTALL_REGISTRATION' })
    assert.equal(JSON.parse(await fs.readFile(locator, 'utf8')).install_root, path.join(parent, 'other'))
    await fs.unlink(locator)
    await privateJson(locator, originalLocator)
    await assert.rejects(removeDesktopInstallationEntries({ ...input, operationId: randomUUID() }), { code: 'CRABOT_DESKTOP_REMOVAL' })
    await fs.unlink(path.join(root, '.desktop-removal.json'))
    await privateJson(path.join(root, '.desktop-removal.json'), { ...fence, phase: 'stopping' })
    await assert.rejects(removeDesktopInstallationEntries(input), { code: 'CRABOT_DESKTOP_REMOVAL' })
    await fs.unlink(path.join(root, '.desktop-removal.json'))
    await privateJson(path.join(root, '.desktop-removal.json'), fence)
    await removeDesktopInstallationEntries(input); await removeDesktopInstallationEntries(input)
    await assert.rejects(fs.lstat(locator), { code: 'ENOENT' })
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, '.desktop-removal.json'), 'utf8')), fence)
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'business dependencies and workspace stay')
    console.log('CRABOT_REMOVAL_INSTALLATION_ENTRIES ' + JSON.stringify({ core_missing: true, discovery_removed: true, repeated_cleanup: true,
      foreign_locator_preserved: true, removal_fence_preserved: true, data_preserved: true, complete_uninstall_tested: false }))

  } finally { for (const lock of held.reverse()) locks.releaseCliLock(lock) }
}).then(() => { clearTimeout(timer); app.exit(0) }, error => { console.error(error.stack); clearTimeout(timer); app.exit(1) })
