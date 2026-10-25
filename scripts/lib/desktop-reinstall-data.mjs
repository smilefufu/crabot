// Trusted installer code only. Inspection and scope preview cannot authorize
// migration, fence completion, version selection or business startup.
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import physical from './physical-fs.cjs'
import identity from './process-identity.cjs'
import product from './product-runtime.cjs'
import installation from './desktop-installation.cjs'
import { acquireExistingCliLock, releaseCliLock, cliLockToken } from './cli-lock.mjs'
import { captureStoppedDesktopRemoval } from './desktop-removal-context.mjs'
import { verifyDesktopPayload, verifyDesktopPrograms } from './desktop-payload.mjs'
import { matchesDesktopRemovalProgram } from './desktop-removal-programs.mjs'
import { readPending } from './desktop-preparation-files.mjs'
import { verifyDataCompatibility } from './data-compatibility.mjs'
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
