// Trusted installer code only. Inspection and scope preview cannot authorize
// migration, fence completion, version selection or business startup.
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import physical from './physical-fs.cjs'
import identity from './process-identity.cjs'
import product from './product-runtime.cjs'
import installation from './desktop-installation.cjs'
import { acquireExistingCliLock, releaseCliLock, cliLockToken } from './cli-lock.mjs'
import { captureStoppedDesktopRemoval, captureDesktopRemovalFacts } from './desktop-removal-context.mjs'
import { readOriginalDesktopPayload } from './desktop-program-proof.mjs'
import { readDesktopRemoval } from './desktop-removal-record.cjs'
import { fileURLToPath } from 'node:url'
import { verifyDesktopPayload, verifyDesktopPrograms } from './desktop-payload.mjs'
import { matchesDesktopRemovalProgram } from './desktop-removal-programs.mjs'
import { readPending } from './desktop-preparation-files.mjs'
import { verifyDataCompatibility } from './data-compatibility.mjs'
const { promises: fs } = physical
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const digest = text => createHash('sha256').update(text).digest('hex')
const directoryIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
const fail = () => { throw Object.assign(new Error('重装兼容检查条件已变化，原数据和维护保护已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
async function withReinstallData({ payload, installRoot, operationId, verifyStopped, signal }, read) {
  if (typeof verifyStopped !== 'function') fail()
  const source = await verifyDesktopPayload(payload, { signal }), own = installation.readDesktopInstallation(installRoot)
  const rootLock = await acquireExistingCliLock(own.root, 'desktop-reinstall-inspect'), rootToken = cliLockToken(rootLock)
  let dataLock, dataToken
  try {
    dataLock = await acquireExistingCliLock(own.dataDir, 'desktop-reinstall-inspect'); dataToken = cliLockToken(dataLock)
    const context = await captureStoppedDesktopRemoval({ installRoot: own.root, operationId })
    if (!same(context.own.record, own.record) || !same(context.proof.payload, source.record)) fail()
    const pending = await readPending(own.root)
    const payloadSha = digest(JSON.stringify(source.record) + '\n')
    if (pending && (pending.installation_id !== own.record.installation_id || !same(pending.selection, source.record.selection) || pending.payload_sha256 !== payloadSha)) fail()
    const current = async () => {
      context.assertStopped()
      await context.proofCurrent()
      if (!same(await readPending(own.root), pending)) fail()
      context.assertStopped()
    }
    await current(); await verifyStopped(); await current(); signal?.throwIfAborted()
    const result = await read({ source, own, context, pending, current, rootToken, dataToken })
    await current(); signal?.throwIfAborted()
    return result
  } finally {
    if (dataToken && cliLockToken(dataLock) === dataToken) releaseCliLock(dataLock)
    if (rootToken && cliLockToken(rootLock) === rootToken) releaseCliLock(rootLock)
  }
}
export async function inspectDesktopReinstallData(options) {
  // Static readers only, including when the original programs are absent.
  return withReinstallData(options, ({ source, own }) => verifyDataCompatibility(path.join(source.directory, 'core'), own.dataDir))
}

// The fixed child only calls the original read-only migration preview. Both
// handles must still belong to its live installer; no new record or MM starts.
const previewTimeout = 20 * 60_000
const previewScript = `
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const [core, root, data, rootToken, dataToken] = process.argv.slice(1)
const timer = setTimeout(() => process.exit(1), ${previewTimeout})
try {
  const locks = await import(pathToFileURL(path.join(core, 'scripts/lib/cli-lock.mjs')).href)
  const current = () => { if (!locks.hasInheritedCliLock(root, rootToken) || !locks.hasInheritedCliLock(data, dataToken)) throw new Error('Preview lock lost') }
  current()
  const { previewMigrations } = await import(pathToFileURL(path.join(core, 'scripts/upgrade-lib/migrate.mjs')).href)
  const result = await previewMigrations(core, data)
  current()
  process.stdout.write(JSON.stringify(result))
} finally { clearTimeout(timer) }
`
export function previewPreparedDesktopReinstallData(options) {
  return withReinstallData(options, async ({ own, source, context, pending, current, rootToken, dataToken }) => {
    if (pending?.phase !== 'prepared') fail()
    const core = path.join(own.root, 'releases', source.record.selection.core_id), gui = path.join(own.root, 'app/releases', source.record.selection.gui_id)
    const directories = [core, gui].map(directory => {
      const stat = physical.lstatSync(directory, { bigint: true })
      if (!stat.isDirectory() || stat.isSymbolicLink() || !identity.isOwnedDirectory(directory)) fail()
      return [directory, directoryIdentity(stat)]
    })
    const assertDirectories = () => {
      if (directories.some(([directory, expected]) => directoryIdentity(physical.lstatSync(directory, { bigint: true })) !== expected)) fail()
    }
    const verifyPrograms = async () => {
      assertDirectories(); await current()
      await verifyDesktopPrograms(core, gui, source.record, { signal: options.signal })
      for (const [key, name] of [['release', 'core-release.json'], ['inventory', 'core-files.json'], ['host', 'desktop-host.json']]) {
        const file = path.join(core, name), text = context.proof.core[key], stat = physical.lstatSync(file, { bigint: true })
        if (!await matchesDesktopRemovalProgram(file, { type: 'file', size: Buffer.byteLength(text), sha256: digest(text) }, stat,
          { owned: (file, stat) => process.platform === 'win32' ? identity.isOwnedFile(file) : stat.uid === BigInt(process.getuid()), signal: options.signal })) fail()
      }
      assertDirectories(); await current()
    }
    await verifyPrograms()
    const versions = verifyDataCompatibility(core, own.dataDir), runtime = product.loadProductRuntime(core, { required: true, full: true })
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []))
    await current(); options.signal?.throwIfAborted(); assertDirectories()
    let result
    try {
      const { stdout } = await promisify(execFile)(runtime.executables.node,
        ['--input-type=module', '--eval', previewScript, core, own.root, own.dataDir, rootToken, dataToken],
        { cwd: core, env, windowsHide: true, timeout: previewTimeout + 5000, killSignal: 'SIGKILL', signal: options.signal, maxBuffer: 128 * 1024 * 1024, encoding: 'utf8' })
      result = JSON.parse(stdout)
    } catch {
      options.signal?.throwIfAborted()
      throw Object.assign(new Error('未能完成数据迁移范围预检，原数据和维护保护已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' })
    }
    if (!Array.isArray(result?.modules) || result.modules.length !== versions.length
      || !result.modules.every((entry, index) => ['moduleId', 'codeVersion', 'dataVersion', 'dataDir'].every(key => entry[key] === versions[index][key]))
      || !['ready', 'not_applicable', 'pending', 'legacy_pending'].includes(result.shared?.status)
      || !(result.backup_bytes === null || Number.isSafeInteger(result.backup_bytes) && result.backup_bytes >= 0)) fail()
    await verifyPrograms()
    return result
  })
}

// Fixed trusted-target Node role. The original GUI's existing version recovery
// owns data conversion, service startup and health; this handoff proves none of them.
export async function handoffPreparedDesktopReinstall({ payload, installRoot, operationId, registerEntries }) {
  if (process.versions.electron || typeof registerEntries !== 'function') fail()
  const source = await verifyDesktopPayload(payload), own = installation.readDesktopInstallation(installRoot)
  const core = path.join(own.root, 'releases', source.record.selection.core_id), gui = path.join(own.root, 'app/releases', source.record.selection.gui_id)
  // Run the target's own lock/maintenance modules in its bundled Node, rather
  // than borrowing a second module-local lock map from installer bootstrap.
  if (physical.realpathSync(fileURLToPath(new URL('../../', import.meta.url))) !== core) fail()
  const runtime = product.loadProductRuntime(core, { required: true, full: true })
  if (physical.realpathSync(process.execPath) !== physical.realpathSync(runtime.executables.node)) fail()
  const rootLock = await acquireExistingCliLock(own.root, 'desktop-reinstall-handoff'), rootToken = cliLockToken(rootLock)
  let dataLock, dataToken
  try {
    dataLock = await acquireExistingCliLock(own.dataDir, 'desktop-reinstall-handoff'); dataToken = cliLockToken(dataLock)
    const context = await captureDesktopRemovalFacts({ installRoot: own.root, operationId })
    if (!['removing', 'completed'].includes(context.record.phase) || !same(source.record, context.proof.payload)) fail()
    const prepared = { installRoot: own.root, installation_id: own.record.installation_id, selection: source.record.selection, coreRoot: core, guiRoot: gui }
    const pending = await readPending(own.root), payloadSha = digest(JSON.stringify(source.record) + '\n')
    if (pending && (pending.phase !== 'prepared' || pending.installation_id !== own.record.installation_id
      || !same(pending.selection, prepared.selection) || pending.payload_sha256 !== payloadSha)) fail()
    const versions = await import('./version-maintenance.mjs')
    const matching = record => record?.schema_version === 3 && record.system_operation_id === undefined
      && record.data_dir === own.dataDir && record.install_root === core && record.source_version === prepared.selection.version
      && record.source_inventory_sha256 === prepared.selection.core_id && record.target_version === prepared.selection.version
      && (record.phase === 'preparing' && record.target_core === undefined
        || record.target_core?.root === core && record.target_core.inventory_sha256 === prepared.selection.core_id)
      && ['preparing', 'prepared', 'installing', 'verifying'].includes(record.phase)
    let record = versions.readVersionMaintenance(own.dataDir)
    if (record && !matching(record)) fail()
    const current = async () => {
      context.assertIdentity(); await context.proofCurrent(); context.assertIdentity()
      try { if (physical.readdirSync(path.join(own.dataDir, 'module-runtime-registry/records')).some(name => name.endsWith('.json'))) fail() }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      const actual = versions.readVersionMaintenance(own.dataDir)
      if (record ? actual?.id !== record.id || !matching(actual) : actual !== null) fail()
      return actual
    }
    const programs = async () => {
      await current()
      await verifyDesktopPrograms(core, gui, source.record)
      const proof = await readOriginalDesktopPayload(own.root, prepared.selection)
      if (proof.text !== JSON.stringify(source.record) + '\n') fail()
      verifyDataCompatibility(core, own.dataDir)
      await current()
    }
    await programs()
    await registerEntries(prepared)
    await programs()
    if (!record) record = await versions.beginVersionMaintenance(own.dataDir, core, prepared.selection.version, prepared.selection.version, { dataProtection: 'scoped' })
    if (record.phase === 'preparing') {
      record = await versions.bindVersionMaintenanceTarget(own.dataDir, record.id, core)
      record = await versions.prepareScopedVersionMaintenance(own.dataDir, record.id)
    }
    if (record.phase === 'prepared') await versions.markVersionMaintenanceInstalling(own.dataDir, record.id)
    const guarded = await current()
    if (!['installing', 'verifying'].includes(guarded.phase)) fail()
    const syncRoot = async () => {
      if (process.platform === 'win32') return
      const directory = await fs.open(own.root, 'r'); try { await directory.sync() } finally { await directory.close() }
    }
    if (!same(await readPending(own.root), pending)) fail()
    if (pending) { await fs.unlink(path.join(own.root, '.desktop-installing.json')); await syncRoot() }
    await current()
    // The existing data fence is durable before either root fence is removed.
    // A lost final reply can still open the restored ordinary GUI for recovery.
    if (!same(readDesktopRemoval(own.root), context.record)) fail()
    await fs.unlink(path.join(own.root, '.desktop-removal.json')); await syncRoot()
    const selected = installation.readDesktopSelection(own.root), actual = versions.readVersionMaintenance(own.dataDir)
    if (!same(selected.selection, prepared.selection) || actual?.id !== guarded.id || !matching(actual)) fail()
    return { executable: selected.executable, dataDir: own.dataDir, maintenance_id: actual.id, verification_pending: true, health_verified: false }
  } finally {
    if (dataToken && cliLockToken(dataLock) === dataToken) releaseCliLock(dataLock)
    if (rootToken && cliLockToken(rootLock) === rootToken) releaseCliLock(rootLock)
  }
}

// Trusted installer side of the fixed Node handoff. Electron owns OS shortcuts;
// the target owns its own lock map, data protection and final root-fence handoff.
const handoffScript = `
import { pathToFileURL } from 'node:url'
const [module, payload, root, id] = process.argv.slice(1)
const timer = setTimeout(() => process.exit(1), ${previewTimeout})
process.once('disconnect', () => process.exit(1))
try {
  const { handoffPreparedDesktopReinstall } = await import(pathToFileURL(module).href)
  const result = await handoffPreparedDesktopReinstall({ payload, installRoot: root, operationId: id,
    registerEntries: prepared => new Promise((resolve, reject) => {
      process.once('message', message => message?.type === 'entries-registered' && message.ok === true ? resolve() : reject(new Error('Entries unavailable')))
      process.send({ type: 'register-entries', prepared })
    }) })
  process.send({ type: 'handoff', result }, () => { clearTimeout(timer); process.removeAllListeners('disconnect'); process.disconnect() })
} catch { clearTimeout(timer); process.exitCode = 1; process.removeAllListeners('disconnect'); process.disconnect() }
`
export async function runPreparedDesktopReinstallHandoff({ payload, installRoot, operationId, registerEntries }) {
  if (typeof registerEntries !== 'function') fail()
  const source = await verifyDesktopPayload(payload), own = installation.readDesktopInstallation(installRoot)
  const core = path.join(own.root, 'releases', source.record.selection.core_id), gui = path.join(own.root, 'app/releases', source.record.selection.gui_id)
  await verifyDesktopPrograms(core, gui, source.record)
  const runtime = product.loadProductRuntime(core, { required: true, full: true })
  const prepared = { installRoot: own.root, installation_id: own.record.installation_id, selection: source.record.selection, coreRoot: core, guiRoot: gui }
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []))
  const child = spawn(runtime.executables.node, ['--input-type=module', '--eval', handoffScript,
    path.join(core, 'scripts/lib/desktop-reinstall-data.mjs'), source.directory, own.root, operationId],
    { cwd: core, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  return new Promise((resolve, reject) => {
    let registered = false, registering = false, result, failed = false
    const stop = () => { failed = true; child.kill('SIGKILL') }
    const timer = setTimeout(stop, previewTimeout + 5000)
    child.once('error', () => { failed = true })
    child.on('message', message => {
      if (failed || !message || typeof message !== 'object') return stop()
      if (message.type === 'register-entries' && !registering && !registered && same(message.prepared, prepared)) {
        registering = true
        void Promise.resolve().then(() => registerEntries(prepared)).then(() => {
          registering = false; registered = true
          if (!failed && child.connected) child.send({ type: 'entries-registered', ok: true }, error => { if (error) stop() })
        }, stop)
      } else if (message.type === 'handoff' && registered && !result
        && message.result?.executable === path.join(gui, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : process.platform === 'win32' ? 'Crabot.exe' : 'crabot-desktop')
        && message.result.dataDir === own.dataDir && message.result.verification_pending === true && message.result.health_verified === false
        && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(message.result.maintenance_id)
        && Object.keys(message.result).length === 5) result = message.result
      else stop()
    })
    child.once('close', code => {
      clearTimeout(timer)
      if (!failed && code === 0 && result) resolve(result)
      else reject(Object.assign(new Error('重装启动交接尚未完成，请使用原安装包继续核验；原数据已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }))
    })
  })
}
