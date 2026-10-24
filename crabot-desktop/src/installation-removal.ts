// Retained-data uninstall component only. The caller owns complete program
// verification, the lifecycle lock and proof that the installation is stopped.
import { promises as fs, type BigIntStats } from 'node:fs'
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
type Snapshot = { file: string; alias: boolean; stat: BigIntStats; content: Buffer | string }
const sameStat = (a: BigIntStats, b: BigIntStats) => (['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const).every(key => a[key] === b[key])

async function snapshot(file: string, alias = false): Promise<Snapshot | null> {
  let stat: BigIntStats
  try { stat = await fs.lstat(file, { bigint: true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  const parent = path.dirname(file), canonical = await fs.realpath(parent)
  const equalPath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!equalPath(canonical, path.resolve(parent)) || !identity.isOwnedDirectory(parent)
    || process.platform !== 'win32' && (await fs.lstat(parent)).mode & 0o022
    || stat.nlink !== 1n || stat.size > 16_384n
    || (process.platform === 'win32' ? !identity.isOwnedFile(file) : stat.uid !== BigInt(process.getuid!()))
    || (alias ? !stat.isSymbolicLink() : !stat.isFile() || stat.isSymbolicLink())) fail()
  const content = alias ? await fs.readlink(file) : await fs.readFile(file)
  if (!sameStat(stat, await fs.lstat(file, { bigint: true }))) fail()
  return { file, alias, stat, content }
}
async function unchanged(expected: Snapshot) {
  const actual = await snapshot(expected.file, expected.alias)
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
  const menu = await snapshot(entry, platform === 'darwin')
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
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(item.file), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  }
}
