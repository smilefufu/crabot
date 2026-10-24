// Retained-data uninstall component only. The caller owns complete program
// verification, the lifecycle lock and proof that the installation is stopped.
import { promises as fs, constants, type BigIntStats } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Shell } from 'electron'
import { desktopApplicationEntry, integrationRoot, readInstallationLocator, type PreparedInstallation } from './installation-entries.js'
const require = createRequire(import.meta.url)
const identity = require('./bootstrap/scripts/lib/process-identity.cjs')
const installation = require('./bootstrap/scripts/lib/desktop-installation.cjs')
const fail = (): never => { throw Object.assign(new Error('系统入口已变化或不属于本安装，已保留剩余入口及全部用户数据。请核对后重试。'), { code: 'CRABOT_INSTALL_REGISTRATION' }) }
type EntryKind = 'file' | 'symlink' | 'junction'
type Snapshot = { file: string; kind: EntryKind; limit: number; stat: BigIntStats; content: Buffer | string }
const sameStat = (a: BigIntStats, b: BigIntStats) => (['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const).every(key => a[key] === b[key])

async function syncDirectory(directory: string) {
  if (process.platform === 'win32') return
  const handle = await fs.open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function snapshot(file: string, kind: EntryKind = 'file', limit = 16_384): Promise<Snapshot | null> {
  let stat: BigIntStats
  try { stat = await fs.lstat(file, { bigint: true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  const parent = path.dirname(file), canonical = await fs.realpath(parent)
  const equalPath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!equalPath(canonical, path.resolve(parent)) || !identity.isOwnedDirectory(parent)
    || process.platform !== 'win32' && (await fs.lstat(parent)).mode & 0o022
    || stat.nlink !== 1n || stat.size > BigInt(limit)
    || (process.platform === 'win32' ? !(kind === 'junction' ? identity.isPrivateDirectory(parent) : identity.isOwnedFile(file)) : stat.uid !== BigInt(process.getuid!()))
    || (kind !== 'file' ? !stat.isSymbolicLink() : !stat.isFile() || stat.isSymbolicLink())) fail()
  let content: Buffer | string
  if (kind !== 'file') content = await fs.readlink(file)
  else {
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      if (!sameStat(stat, await handle.stat({ bigint: true }))) fail()
      content = Buffer.alloc(Number(stat.size))
      let offset = 0
      while (offset < content.length) {
        const { bytesRead } = await handle.read(content, offset, content.length - offset, offset)
        if (!bytesRead) fail()
        offset += bytesRead
      }
      if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead || !sameStat(stat, await handle.stat({ bigint: true }))) fail()
    } finally { await handle.close() }
  }
  if (Buffer.byteLength(content) > limit || !sameStat(stat, await fs.lstat(file, { bigint: true }))) fail()
  return { file, kind, limit, stat, content }
}
async function unchanged(expected: Snapshot) {
  const actual = await snapshot(expected.file, expected.kind, expected.limit)
  if (!actual || !sameStat(actual.stat, expected.stat)
    || (typeof expected.content === 'string' ? actual.content !== expected.content
      : !Buffer.isBuffer(actual.content) || !expected.content.equals(actual.content))) fail()
}

export async function removeInstallationEntries(prepared: PreparedInstallation, options: {
  home: string; platform: string; env: NodeJS.ProcessEnv; shell: Pick<Shell, 'readShortcutLink'>
  verifyStopped: () => Promise<void>; unregisterMac?: (application: string) => Promise<unknown>
}): Promise<void> {
  const { home, platform, env, shell } = options
  if (!['darwin', 'win32', 'linux'].includes(platform) || typeof options.verifyStopped !== 'function') fail()
  const current = () => {
    const own = installation.readDesktopSelection(prepared.installRoot)
    if (own.root !== prepared.installRoot || own.record.installation_id !== prepared.installation_id
      || own.guiRoot !== prepared.guiRoot || own.coreRoot !== prepared.coreRoot
      || Object.keys(own.selection).some(key => own.selection[key] !== prepared.selection?.[key as keyof PreparedInstallation['selection']])
      || Object.keys(prepared.selection).length !== 4) fail()
  }
  const stopped = async () => { current(); await options.verifyStopped(); current() }
  await stopped()
  const locator = await readInstallationLocator(home, platform, env)
  if (locator && (locator.install_root !== prepared.installRoot || locator.installation_id !== prepared.installation_id)) fail()
  const locatorFile = await snapshot(path.join(integrationRoot(home, platform, env), 'installation.json'))
  if (locatorFile && (locatorFile.content.toString() !== JSON.stringify({ schema_version: 1, owner: identity.inspectProcess(process.pid).owner,
    install_root: prepared.installRoot, installation_id: prepared.installation_id }) + '\n'
    || (process.platform === 'win32' ? !identity.isPrivateFile(locatorFile.file) : (locatorFile.stat.mode & 0o777n) !== 0o600n))) fail()
  const entry = platform === 'darwin' ? path.join(home, 'Applications/Crabot.app') : platform === 'win32'
    ? path.join(env.APPDATA || path.join(home, 'AppData/Roaming'), 'Microsoft/Windows/Start Menu/Programs/Crabot.lnk')
    : path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'), 'applications/crabot.desktop')
  const menu = await snapshot(entry, platform === 'darwin' ? 'symlink' : 'file')
  if (menu) {
    if (platform === 'darwin') {
      if (menu.content !== path.join(prepared.guiRoot, 'Crabot.app')) fail()
    } else if (platform === 'linux') {
      if (menu.content.toString() !== desktopApplicationEntry(path.join(prepared.guiRoot, 'crabot-desktop'),
        path.join(prepared.guiRoot, 'resources/crabot.png'), prepared.installation_id)) fail()
    } else {
      const value = shell.readShortcutLink(entry), executable = path.join(prepared.guiRoot, 'Crabot.exe')
      if (value.target !== executable || value.args || value.cwd !== prepared.guiRoot || value.icon !== executable
        || value.iconIndex !== 0 || value.description !== 'Crabot' || value.appUserModelId !== 'com.crabot.desktop') fail()
    }
  }
  // All entries must pass before changing any of them. Keep the locator last so
  // a partial operation remains discoverable for repair and a verified retry.
  const entries = [menu, locatorFile].filter((value): value is Snapshot => value !== null)
  await stopped()
  for (const item of entries) await unchanged(item)
  if (platform === 'darwin') {
    const unregister = options.unregisterMac || (async (application: string) => promisify(execFile)(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-u', application], { timeout: 30_000, maxBuffer: 64 * 1024 }))
    await unregister(path.join(prepared.guiRoot, 'Crabot.app'))
  }
  for (const item of entries) {
    await stopped(); await unchanged(item)
    await fs.unlink(item.file)
    await syncDirectory(path.dirname(item.file))
  }
}


// Current paired-desktop CLI registration only. No independent CLI/system
// takeover, shell/PATH mutation, service stop or program deletion occurs here.
export async function removeDesktopCliEntries(options: {
  installRoot: string; operationId: string; home: string; env: NodeJS.ProcessEnv
}): Promise<{ removed: string[]; retained: boolean }> {
  const removalFail = (): never => { throw Object.assign(new Error('卸载作业、操作锁或停止结果无法核验，命令入口和用户数据已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
  const load = (file: string) => import(new URL('./bootstrap/scripts/lib/' + file, import.meta.url).href)
  const [proofs, locks, runtime, workspace, text] = await Promise.all([
    load('desktop-removal-proof.mjs'), load('cli-lock.mjs'), load('instance-runtime.mjs'), load('workspace-maintenance.cjs'), load('desktop-cli-text.mjs'),
  ])
  const physical = require('./bootstrap/scripts/lib/physical-fs.cjs')
  const own = installation.readDesktopInstallation(options.installRoot)
  const directoryIdentity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
  const dataIdentity = directoryIdentity(physical.lstatSync(own.dataDir, { bigint: true }))
  const initial = await proofs.readDesktopRemovalProof(own.root)
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const removal = require('./bootstrap/scripts/lib/desktop-removal-record.cjs')
  const held = [own.root, own.dataDir].map(directory => {
    const file = path.join(directory, 'cli.lock')
    return { directory, file, token: locks.cliLockToken(file) }
  })
  // Final synchronous binding directly precedes each unlink; an earlier async
  // proof/snapshot must not retain authority after either OS lock was released.
  const assertJob = () => {
    const actual = removal.readDesktopRemoval(own.root)
    if (actual?.phase !== 'removing' || actual.operation_id !== options.operationId || !same(actual, initial.record)
      || !same(installation.readDesktopInstallation(own.root).record, own.record)
      || !same(installation.readDesktopPairReference(own.root).selection, initial.record.source_selection)
      || directoryIdentity(physical.lstatSync(own.dataDir, { bigint: true })) !== dataIdentity
      || !held.every(lock => lock.token && locks.cliLockToken(lock.file) === lock.token && locks.hasInheritedCliLock(lock.directory, lock.token))
      || workspace.workspaceMaintenancePending(own.dataDir) || runtime.inspectInstance(own.dataDir).state !== 'stopped') removalFail()
    try { physical.lstatSync(path.join(own.dataDir, 'desktop-maintenance.json')); removalFail() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    try { if (physical.readdirSync(path.join(own.dataDir, 'module-runtime-registry/records')).some((file: string) => file.endsWith('.json'))) removalFail() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const current = async (): Promise<boolean> => {
    if (!same((await proofs.readDesktopRemovalProof(own.root)).record, initial.record)) removalFail()
    const locator = await readInstallationLocator(options.home, process.platform, options.env)
    assertJob()
    return !locator || locator.install_root === own.root && locator.installation_id === own.record.installation_id
  }
  if (!await current()) return { removed: [], retained: true }
  const windows = process.platform === 'win32'
  const prefix = windows ? path.join(options.env.LOCALAPPDATA || path.join(options.home, 'AppData/Local'), 'Crabot/cli') : path.join(options.home, '.local/bin')
  const entry = path.join(prefix, windows ? 'crabot.cmd' : 'crabot'), pointer = path.join(prefix, '.crabot-desktop-core'), metadata = path.join(prefix, '.crabot-desktop-cli.json')
  let entries: Snapshot[]
  try {
    let stat
    try { stat = await fs.lstat(prefix) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: [], retained: false }; throw error }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !identity.isOwnedDirectory(prefix)
      || windows && !identity.isPrivateDirectory(prefix) || !windows && stat.mode & 0o022) fail()
    const record = await snapshot(metadata, 'file', 65_536), command = await snapshot(entry, windows ? 'file' : 'symlink')
    const link = windows ? await snapshot(pointer, 'junction', 65_536) : null
    if (record && (!Buffer.isBuffer(record.content) || !record.content.equals(Buffer.from(JSON.stringify({ schema_version: 2, install_root: own.root }) + '\n'))
      || (windows ? !identity.isPrivateFile(metadata) : (record.stat.mode & 0o777n) !== 0o600n))) fail()
    if (windows) {
      if (command && (!Buffer.isBuffer(command.content) || !command.content.equals(Buffer.from(text.windowsPairedCommand)))) fail()
      if (link && path.toNamespacedPath(String(link.content)).toLowerCase() !== path.toNamespacedPath(own.root).toLowerCase()) fail()
      if (command && !link) fail()
    } else if (command && command.content !== path.join(own.root, 'bin/crabot')) fail()
    entries = [command, link, record].filter((value): value is Snapshot => value !== null)
    for (const entry of entries) await unchanged(entry)
  } catch { return { removed: [], retained: true } }
  const removed: string[] = []
  for (const entry of entries) {
    if (!await current()) return { removed, retained: true }
    try { await unchanged(entry) } catch { return { removed, retained: true } }
    assertJob()
    await fs.unlink(entry.file)
    await syncDirectory(prefix)
    removed.push(path.basename(entry.file))
  }
  if (!entries.length) await syncDirectory(prefix)
  if (!await current()) return { removed, retained: true }
  return { removed, retained: false }
}
