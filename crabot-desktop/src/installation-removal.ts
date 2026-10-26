// Retained-data uninstall component only. The caller owns complete program
// verification, the lifecycle lock and proof that the installation is stopped.
import fsSync, { promises as fs, constants, type BigIntStats } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { App, Shell } from 'electron'
import { desktopApplicationEntry, integrationRoot, readInstallationLocator, type PreparedInstallation } from './installation-entries.js'
import { ubuntuLoginStartupEntry } from './login-startup.js'
const require = createRequire(import.meta.url)
const identity = require('./bootstrap/scripts/lib/process-identity.cjs')
const installation = require('./bootstrap/scripts/lib/desktop-installation.cjs')
const management = require('./bootstrap/scripts/lib/desktop-management.cjs')
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

type EntryRemovalOptions = {
  home: string; platform: string; env: NodeJS.ProcessEnv; shell: Pick<Shell, 'readShortcutLink'>
  verifyStopped: () => Promise<void>; unregisterMac?: (application: string) => Promise<unknown>
}

export async function removeInstallationEntries(prepared: PreparedInstallation, options: EntryRemovalOptions): Promise<void> {
  const current = () => {
    const own = installation.readDesktopSelection(prepared.installRoot)
    if (own.root !== prepared.installRoot || own.record.installation_id !== prepared.installation_id
      || own.guiRoot !== prepared.guiRoot || own.coreRoot !== prepared.coreRoot
      || Object.keys(own.selection).some(key => own.selection[key] !== prepared.selection?.[key as keyof PreparedInstallation['selection']])
      || Object.keys(prepared.selection).length !== 4) fail()
  }
  return removeEntries(prepared, options, current, 'menu-and-locator')
}

// Common byte/shortcut cleanup only; the fixed entrypoint supplies its own admission.
async function removeEntries(prepared: PreparedInstallation, options: EntryRemovalOptions, current: () => void, scope: 'menu-only' | 'menu-and-locator'): Promise<void> {
  const { home, platform, env, shell } = options
  if (!['darwin', 'win32', 'linux'].includes(platform) || typeof options.verifyStopped !== 'function') fail()
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
  const entries = [menu, ...(scope === 'menu-and-locator' ? [locatorFile] : [])].filter((value): value is Snapshot => value !== null)
  await stopped()
  for (const item of entries) await unchanged(item)
  if (platform === 'darwin') {
    const unregister = options.unregisterMac || (async (application: string) => promisify(execFile)(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-u', application], { timeout: 30_000, maxBuffer: 64 * 1024 }))
    current()
    await unregister(path.join(prepared.guiRoot, 'Crabot.app'))
  }
  for (const item of entries) {
    await stopped(); await unchanged(item)
    current()
    await fs.unlink(item.file)
    await syncDirectory(path.dirname(item.file))
  }
}


type RemovalJobOptions = { installRoot: string; operationId: string }
async function captureRemovalJob(options: RemovalJobOptions) {
  const { captureDesktopRemovalJob } = await import(new URL('./bootstrap/scripts/lib/desktop-removal-context.mjs', import.meta.url).href)
  return captureDesktopRemovalJob(options)
}

// Removal-job entry cleanup keeps its own admission even after Core is gone.
// The full host orders locator removal after its other cleanup responsibilities.
async function removeJobEntries(options: RemovalJobOptions & Pick<EntryRemovalOptions, 'home' | 'env' | 'shell' | 'unregisterMac'>,
  scope: 'menu-only' | 'menu-and-locator'): Promise<void> {
  const { own, record, assertJob, proofCurrent } = await captureRemovalJob(options)
  const prepared = { installRoot: own.root, installation_id: own.record.installation_id, selection: record.source_selection,
    coreRoot: path.join(own.root, 'releases', record.source_selection.core_id), guiRoot: path.join(own.root, 'app/releases', record.source_selection.gui_id) }
  await removeEntries(prepared, { ...options, platform: process.platform, verifyStopped: async () => { await proofCurrent(); assertJob() } }, assertJob, scope)
}
export function removeDesktopMenuEntry(options: RemovalJobOptions & Pick<EntryRemovalOptions, 'home' | 'env' | 'shell' | 'unregisterMac'>): Promise<void> {
  return removeJobEntries(options, 'menu-only')
}
export function removeDesktopInstallationEntries(options: RemovalJobOptions & Pick<EntryRemovalOptions, 'home' | 'env' | 'shell' | 'unregisterMac'>): Promise<void> {
  return removeJobEntries(options, 'menu-and-locator')
}

// Current paired-desktop CLI registration only. No independent CLI/system
// takeover, shell/PATH mutation, service stop or program deletion occurs here.
export async function removeDesktopCliEntries(options: {
  installRoot: string; operationId: string; home: string; env: NodeJS.ProcessEnv
}): Promise<{ removed: string[]; retained: boolean }> {
  const { own, assertJob, proofCurrent } = await captureRemovalJob(options)
  const text = await import(new URL('./bootstrap/scripts/lib/desktop-cli-text.mjs', import.meta.url).href)
  const current = async (): Promise<boolean> => {
    await proofCurrent()
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


// Ubuntu's fixed autostart file only. No OS login APIs, discovery release,
// program deletion or business startup; the trusted host owns OS routing.
export async function removeUbuntuAutostartEntry(options: RemovalJobOptions & { home: string; env: NodeJS.ProcessEnv }): Promise<void> {
  const { own, record, assertJob, proofCurrent } = await captureRemovalJob(options)
  const current = async () => {
    await proofCurrent()
    const locator = await readInstallationLocator(options.home, process.platform, options.env)
    assertJob()
    if (locator && (locator.install_root !== own.root || locator.installation_id !== own.record.installation_id)) fail()
  }
  await current()
  const configHome = options.env.XDG_CONFIG_HOME || path.join(options.home, '.config')
  if (!path.isAbsolute(configHome)) fail()
  const entry = path.join(configHome, 'autostart/crabot.desktop'), item = await snapshot(entry)
  if (item && (!Buffer.isBuffer(item.content) || !item.content.equals(Buffer.from(ubuntuLoginStartupEntry(
    path.join(own.root, 'app/releases', record.source_selection.gui_id, 'crabot-desktop'))))
    || process.platform !== 'win32' && (item.stat.mode & 0o777n) !== 0o600n)) fail()
  await current()
  if (!item) return
  await unchanged(item)
  assertJob()
  const parent = path.dirname(entry), canonical = fsSync.realpathSync(parent)
  if ((process.platform === 'win32' ? canonical.toLowerCase() !== path.resolve(parent).toLowerCase() : canonical !== path.resolve(parent))
    || !sameStat(fsSync.lstatSync(entry, { bigint: true }), item.stat)) fail()
  fsSync.unlinkSync(entry)
  await syncDirectory(parent)
  await current()
  // A new or late replacement is retained and reported, never silently removed.
  if (await snapshot(entry)) fail()
  assertJob()
}


// Fixed current-user Windows Run value only. The native operation verifies the
// original program and switches again; no StartupApproved bytes are rewritten.
export async function removeWindowsLoginStartupEntry(options: RemovalJobOptions & { home: string; env: NodeJS.ProcessEnv }): Promise<void> {
  const { own, record, assertJob, proofCurrent } = await captureRemovalJob(options)
  const current = async () => {
    await proofCurrent()
    const locator = await readInstallationLocator(options.home, process.platform, options.env)
    assertJob()
    if (locator && (locator.install_root !== own.root || locator.installation_id !== own.record.installation_id)) fail()
  }
  await current()
  if (typeof identity.removeDesktopLoginStartup !== 'function' || typeof identity.inspectDesktopLoginStartup !== 'function') fail()
  const executable = path.join(own.root, 'app/releases', record.source_selection.gui_id, 'Crabot.exe')
  assertJob()
  if (identity.removeDesktopLoginStartup(executable) !== true) fail()
  await current()
  if (identity.inspectDesktopLoginStartup(executable) !== 'absent') fail()
  assertJob()
}

// macOS scopes this API to the calling app, so it must be the verified private
// copy of this installation. Core and original GUI may already be removed.
export async function removeMacLoginStartupEntry(options: RemovalJobOptions & {
  app: Pick<App, 'getLoginItemSettings' | 'setLoginItemSettings'>
  maintenancePayload?: { selection: { version: string } }
}): Promise<void> {
  if (process.platform !== 'darwin') fail()
  const { own, proof, assertJob, proofCurrent } = await captureRemovalJob(options)
  const self = identity.inspectProcess(process.pid), executable = fsSync.realpathSync(process.execPath)
  const guiRoot = path.resolve(path.dirname(executable), '../../..')
  const directory = management.requirePrivateDataRoot(path.dirname(guiRoot))
  if (path.basename(guiRoot) !== 'gui' || !/^crabot-removal-host-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(path.basename(directory))
    || directory === own.root || directory.startsWith(own.root + path.sep) || own.root.startsWith(directory + path.sep)
    || !self || self.owner !== own.record.owner || fsSync.realpathSync(self.executable) !== executable) fail()
  const generation = () => {
    const value = fsSync.lstatSync(directory, { bigint: true })
    return [value.dev, value.ino, value.mode, value.uid, value.gid].join(':')
  }
  const original = generation()
  const current = () => {
    assertJob()
    if (management.requirePrivateDataRoot(directory) !== directory || generation() !== original
      || fsSync.realpathSync(process.cwd()) !== directory || !identity.sameProcess(self, identity.inspectProcess(process.pid))) fail()
  }
  const { verifyDesktopGui } = await import(new URL('./bootstrap/scripts/lib/desktop-payload.mjs', import.meta.url).href)
  const payload = options.maintenancePayload ?? proof.payload
  if (options.maintenancePayload) {
    const { assertReinstallVersion } = await import(new URL('./bootstrap/scripts/lib/desktop-reinstall.mjs', import.meta.url).href)
    assertReinstallVersion(proof.source_selection.version, payload.selection.version)
  }
  current(); await proofCurrent(); await verifyDesktopGui(guiRoot, payload); await proofCurrent(); current()
  options.app.setLoginItemSettings({ openAtLogin: false })
  const result = options.app.getLoginItemSettings()
  current()
  if (result.status !== 'not-registered' || result.openAtLogin !== false) fail()
}

// This fixed installation key is independent of the removed original program.
export async function removeWindowsUninstallEntry(options: RemovalJobOptions): Promise<void> {
  if (process.platform !== 'win32') fail()
  const { own, record, assertJob, proofCurrent } = await captureRemovalJob(options)
  await proofCurrent(); assertJob()
  const original = { installRoot: own.root, executable: path.join(own.root, 'app/releases', record.source_selection.gui_id, 'Crabot.exe'),
    version: record.source_selection.version }
  if (typeof identity.removeDesktopUninstallEntry !== 'function'
    || identity.removeDesktopUninstallEntry(own.record.installation_id, original) !== true) fail()
  await proofCurrent(); assertJob()
}

// Fixed host cleanup order: login/standard uninstall entry, owned CLI, then
// menu and discovery last. The host settles the removal job only on success.
export async function removeDesktopUserEntries(options: RemovalJobOptions & {
  home: string; env: NodeJS.ProcessEnv; shell?: Pick<Shell, 'readShortcutLink'>
  app?: Pick<App, 'getLoginItemSettings' | 'setLoginItemSettings'>
  maintenancePayload?: { selection: { version: string } }
  unregisterMac?: (application: string) => Promise<unknown>
}): Promise<void> {
  if (process.platform === 'darwin') {
    const app = options.app
    if (!app) return fail()
    await removeMacLoginStartupEntry({ ...options, app })
  } else if (process.platform === 'win32') {
    await removeWindowsLoginStartupEntry(options)
    await removeWindowsUninstallEntry(options)
  } else if (process.platform === 'linux') await removeUbuntuAutostartEntry(options)
  else fail()
  if ((await removeDesktopCliEntries(options)).retained) fail()
  await removeDesktopInstallationEntries({ ...options, shell: options.shell ?? { readShortcutLink: () => fail() } })
}
