// User-level OS entries only. The installer owns payload verification and final
// pair commit; these entries cannot select another Core or start a service.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Shell } from 'electron'
const identity = createRequire(import.meta.url)('./bootstrap/scripts/lib/process-identity.cjs')
const installation = createRequire(import.meta.url)('./bootstrap/scripts/lib/desktop-installation.cjs')
export interface PreparedInstallation {
  installRoot: string
  installation_id: string
  selection: { schema_version: 1; version: string; gui_id: string; core_id: string }
  coreRoot: string
  guiRoot: string
}
const fail = () => { throw Object.assign(new Error('系统入口与原有记录不一致，已有文件已保留。请检查安装位置后重试。'), { code: 'CRABOT_INSTALL_REGISTRATION' }) }
async function present(file: string) { try { return await fs.lstat(file) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error } }
export function integrationRoot(home: string, platform: string, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Crabot/desktop-integration')
  if (platform === 'darwin') return path.join(home, 'Library/Application Support/Crabot/desktop-integration')
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'crabot/desktop-integration')
}
export function desktopApplicationEntry(executable: string, icon: string, installationId: string): string {
  if ([executable, icon].some(value => /[\r\n\0=]/.test(value)) || !/^[a-f0-9-]{36}$/.test(installationId)) fail()
  const quoted = executable.replace(/\\/g, '\\\\\\\\').replace(/"/g, '\\\\"').replace(/`/g, '\\\\`').replace(/\$/g, '\\\\$').replace(/%/g, '%%')
  return `[Desktop Entry]\nType=Application\nName=Crabot\nExec=/usr/bin/env -- "${quoted}"\nIcon=${icon.replace(/\\/g, '\\\\')}\nTerminal=false\nCategories=Utility;\nX-Crabot-Installation=${installationId}\n`
}
async function ownedDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  if (!identity.isOwnedDirectory(directory)) fail()
  const stat = await fs.lstat(directory)
  if (stat.isSymbolicLink() || process.platform !== 'win32' && stat.mode & 0o022) fail()
}
async function writeUnchanged(file: string, text: string) {
  const stat = await present(file)
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16_384
      || (process.platform === 'win32' ? !identity.isOwnedFile(file) : stat.uid !== process.getuid!())
      || await fs.readFile(file, 'utf8') !== text) fail()
    return
  }
  const temporary = file + '.tmp-' + randomUUID()
  try {
    if (process.platform === 'win32') identity.writePrivateFile(temporary, text)
    else await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600, flush: true })
    await fs.link(temporary, file)
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(file), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally { await fs.rm(temporary, { force: true }) }
}
export async function readInstallationLocator(home: string, platform: string, env: NodeJS.ProcessEnv): Promise<{ install_root: string; installation_id: string } | null> {
  const file = path.join(integrationRoot(home, platform, env), 'installation.json'), stat = await present(file)
  if (!stat) return null
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16_384
    || (process.platform === 'win32' ? !identity.isPrivateFile(file) : stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600)) fail()
  let record
  try { record = JSON.parse(await fs.readFile(file, 'utf8')) } catch { fail() }
  if (record.schema_version !== 1 || record.owner !== identity.inspectProcess(process.pid).owner || typeof record.install_root !== 'string'
    || !path.isAbsolute(record.install_root) || typeof record.installation_id !== 'string' || !/^[a-f0-9-]{36}$/.test(record.installation_id)
    || Object.keys(record).some(key => !['schema_version', 'owner', 'install_root', 'installation_id'].includes(key))) fail()
  return record
}
export async function registerInstallationEntries(prepared: PreparedInstallation, options: {
  home: string; platform: string; env: NodeJS.ProcessEnv; shell: Pick<Shell, 'writeShortcutLink' | 'readShortcutLink'>;
  registerMac?: (application: string) => Promise<unknown>
}) {
  const { home, platform, env, shell } = options, root = installation.readDesktopInstallation(prepared.installRoot)
  if (root.record.installation_id !== prepared.installation_id || prepared.guiRoot !== path.join(root.root, 'app/releases', prepared.selection.gui_id)) fail()
  const locator = await readInstallationLocator(home, platform, env)
  if (locator && (locator.install_root !== root.root || locator.installation_id !== prepared.installation_id)) fail()
  const registration = integrationRoot(home, platform, env)
  await ownedDirectory(registration)
  // Claim the user locator before publishing menus; concurrent installations of
  // different roots cannot both become the selected installation for this user.
  await writeUnchanged(path.join(registration, 'installation.json'), JSON.stringify({ schema_version: 1, owner: identity.inspectProcess(process.pid).owner,
    install_root: root.root, installation_id: prepared.installation_id }) + '\n')
  if (platform === 'darwin') {
    const applications = path.join(home, 'Applications'), alias = path.join(applications, 'Crabot.app'), application = path.join(prepared.guiRoot, 'Crabot.app')
    await ownedDirectory(applications)
    const stat = await present(alias)
    if (stat) {
      if (!stat.isSymbolicLink() || stat.uid !== process.getuid!() || await fs.realpath(alias) !== application) fail()
    } else await fs.symlink(application, alias, 'dir')
    const register = options.registerMac || (async app => promisify(execFile)('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app], { timeout: 30_000, maxBuffer: 64 * 1024 }))
    await register(application)
    return
  }
  if (platform === 'win32') {
    const directory = path.join(env.APPDATA || path.join(home, 'AppData/Roaming'), 'Microsoft/Windows/Start Menu/Programs')
    await ownedDirectory(directory)
    const entry = path.join(directory, 'Crabot.lnk'), executable = path.join(prepared.guiRoot, 'Crabot.exe'), stat = await present(entry)
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink() || !identity.isOwnedFile(entry)) fail()
      const shortcut = shell.readShortcutLink(entry)
      if (shortcut.target !== executable || shortcut.args) fail()
    } else if (!shell.writeShortcutLink(entry, 'create', { target: executable, cwd: prepared.guiRoot, description: 'Crabot', icon: executable, iconIndex: 0, appUserModelId: 'com.crabot.desktop' })) fail()
    return
  }
  if (platform !== 'linux') fail()
  const applications = path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'), 'applications')
  await ownedDirectory(applications)
  await writeUnchanged(path.join(applications, 'crabot.desktop'), desktopApplicationEntry(path.join(prepared.guiRoot, 'crabot-desktop'),
    path.join(prepared.guiRoot, 'resources/crabot.png'), prepared.installation_id))
}
