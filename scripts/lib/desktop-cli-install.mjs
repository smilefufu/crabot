// Explicit native-menu action. Only registers this verified desktop payload for
// the current OS user; takeover owns the separate legacy-entry migration.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import desktop from './desktop-entry.cjs'
import installation from './desktop-installation.cjs'
import identity from './process-identity.cjs'
import management from './desktop-management.cjs'
import { verifyCoreRelease } from './core-release.mjs'
import { acquireExistingCliLock, releaseCliLock } from './cli-lock.mjs'
import { assertVersionMaintenanceAllowsStart } from './version-maintenance.mjs'
import { detectMode } from './mode.mjs'
import { notifyCliPathChange } from './cli-path-notification.mjs'
import { windowsCommand, windowsPairedCommand } from './desktop-cli-text.mjs'

const start = '# >>> Crabot desktop CLI >>>', end = '# <<< Crabot desktop CLI <<<'
const pathBlock = `${start}\ncase ":$PATH:" in\n  *":$HOME/.local/bin:"*) ;;\n  *) export PATH="$HOME/.local/bin:$PATH" ;;\nesac\n${end}`
const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_CLI_INSTALL_REQUIRED' }) }
async function stat(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function regular(file) {
  const value = await stat(file)
  if (!value) return null
  const owned = process.platform === 'win32' ? identity.isOwnedFile(file) : String(value.uid) === identity.inspectProcess(process.pid).owner
  if (!value.isFile() || value.size > 1024 * 1024 || !owned) fail('发现无法确认归属的命令或 shell 配置，已有内容已保留。')
  return { text: await fs.readFile(file, 'utf8'), mode: value.mode & 0o777 }
}
async function publish(file, text, previous) {
  const current = await regular(file)
  if (current?.text !== previous?.text) fail('配置在安装期间发生变化，请重新检查后重试。')
  const temporary = file + '.crabot-' + randomUUID()
  try {
    if (process.platform === 'win32') identity.writePrivateFile(temporary, text)
    else {
      await fs.writeFile(temporary, text, { flag: 'wx', mode: previous?.mode ?? 0o600, flush: true })
      if (previous) await fs.chmod(temporary, previous.mode)
    }
    if ((await regular(file))?.text !== previous?.text) fail('配置在安装期间发生变化，请重新检查后重试。')
    if (previous) await fs.rename(temporary, file)
    else await fs.link(temporary, file)
  } finally { await fs.rm(temporary, { force: true }) }
}
async function ownedDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const value = await fs.lstat(directory)
  if (!identity.isOwnedDirectory(directory) || value.isSymbolicLink() || value.mode & 0o022) fail('命令目录的归属或写入权限需要检查，未替换已有入口。')
}
async function link(file, target, previousTarget, directory = false) {
  const current = await stat(file)
  if (!current) { await fs.symlink(target, file, directory ? 'junction' : undefined); return }
  if (!current.isSymbolicLink()) fail('发现已有自定义命令入口，请先完成旧安装接管。')
  const originalTarget = await fs.readlink(file), actual = path.resolve(path.dirname(file), originalTarget)
  const comparable = value => process.platform === 'win32' ? path.toNamespacedPath(value) : value
  if (comparable(actual) === comparable(target)) return
  if (!previousTarget || comparable(actual) !== comparable(previousTarget)) fail('已有命令入口与受管记录不一致，未作替换。')
  const temporary = file + '.crabot-' + randomUUID()
  try {
    await fs.symlink(target, temporary, directory ? 'junction' : undefined)
    // Windows cannot rename over a directory junction. Remove only the exact
    // owned registration verified above; interruption is repaired by repeating.
    if (await fs.readlink(file) !== originalTarget) fail('命令入口在安装期间发生变化，请重新检查后重试。')
    if (directory) await fs.unlink(file)
    await fs.rename(temporary, file)
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
async function shellChanges(home, env) {
  const shell = path.basename(env.SHELL || (process.platform === 'darwin' ? 'zsh' : 'bash'))
  let files
  if (shell === 'zsh') {
    const directory = path.resolve(env.ZDOTDIR || home)
    if (directory !== home && !identity.isOwnedDirectory(directory)) fail('无法确认 zsh 配置目录，已有配置保留。')
    files = [path.join(directory, '.zprofile'), path.join(directory, '.zshrc')]
  } else if (shell === 'bash') {
    let login = path.join(home, '.bash_profile')
    for (const name of ['.bash_profile', '.bash_login', '.profile']) if (await stat(path.join(home, name))) { login = path.join(home, name); break }
    files = [login, path.join(home, '.bashrc')]
  } else fail('此 shell 尚不支持自动配置命令入口。请继续通过桌面应用管理 Crabot。')
  const changes = []
  for (const file of files) {
    const previous = await regular(file), text = previous?.text ?? ''
    if (text.includes(start) || text.includes(end)) {
      if (text.split(start).length !== 2 || text.split(end).length !== 2 || !text.includes(pathBlock)) fail('已有 Crabot shell 配置块被修改，请保留配置并先检查。')
    } else changes.push({ file, previous, text: text + (text.endsWith('\n') || !text ? '' : '\n') + '\n' + pathBlock + '\n' })
  }
  return changes
}

export async function installDesktopCli({ coreRoot, dataDir, home = homedir(), env = process.env }) {
  coreRoot = await fs.realpath(coreRoot); home = await fs.realpath(home)
  if (detectMode() === 'system' || env.CRABOT_DEV === 'true' || Number(env.CRABOT_PORT_OFFSET ?? 0) !== 0) fail('此部署继续使用已有管理命令；请先确认部署来源。')
  if (!desktop.loadDesktopEntry(coreRoot) || !(await stat(path.join(coreRoot, 'desktop-host.json')))?.isFile()) fail('命令安装需要完整的桌面发行。')
  await verifyCoreRelease(coreRoot)
  const paired = installation.locateDesktopCore(coreRoot)
  if (paired && paired.dataDir !== await fs.realpath(dataDir)) fail('命令必须使用桌面安装内的同一份数据，未修改已有入口。')
  const registeredRoot = paired?.root ?? coreRoot
  if (!identity.isOwnedDirectory(home)) fail('无法确认当前用户目录。')
  const windows = process.platform === 'win32'
  const prefix = windows ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Crabot/cli') : path.join(home, '.local/bin')
  const metadata = path.join(prefix, '.crabot-desktop-cli.json'), entry = path.join(prefix, windows ? 'crabot.cmd' : 'crabot')
  const lock = await acquireExistingCliLock(dataDir, 'desktop-install-cli')
  let shellFiles
  try {
    assertVersionMaintenanceAllowsStart(dataDir)
    if (paired) installation.locateDesktopCore(coreRoot)
    if (windows) management.ensurePrivateDataRoot(prefix)
    else await ownedDirectory(prefix)
    const previous = await regular(metadata)
    let previousRoot
    if (previous) {
      try {
        const value = JSON.parse(previous.text)
        if (![1, 2].includes(value.schema_version) || typeof (value.install_root ?? value.core_root) !== 'string' || !path.isAbsolute(value.install_root ?? value.core_root)) throw new Error()
        if (value.schema_version === 2 && (!value.install_root || value.core_root) || value.schema_version === 1 && (!value.core_root || value.install_root)) throw new Error()
        previousRoot = value.install_root ?? value.core_root
      } catch { fail('命令注册记录无法核对，请保留现有入口并检查安装。') }
    }
    const priorPath = windows ? identity.readUserPath() : null
    const search = [...(env.PATH || env.Path || '').split(path.delimiter), ...(windows ? (priorPath || '').split(';') : [])]
    const directories = search.filter(Boolean).map(value => windows ? value.replace(/^"|"$/g, '').replace(/%([^%]+)%/g,
      (all, key) => Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] ?? all) : value)
    const allowed = [await fs.realpath(prefix), await fs.realpath(path.join(registeredRoot, 'bin'))]
    for (const directory of new Set(directories)) {
      if (allowed.includes(await fs.realpath(directory).catch(() => path.resolve(directory)))) continue
      for (const name of windows ? ['crabot.exe', 'crabot.cmd', 'crabot.bat'] : ['crabot']) {
        if (await stat(path.join(directory, name))) fail('发现其它位置已有 crabot 命令，请先完成旧安装接管，避免连接到不同实例。')
      }
    }
    const changes = windows ? [] : await shellChanges(home, env)
    if (windows) {
      const command = await regular(entry), text = paired ? windowsPairedCommand : windowsCommand
      if (command && command.text !== windowsCommand && command.text !== windowsPairedCommand) fail('发现已有自定义命令入口，请先完成旧安装接管。')
      await link(path.join(prefix, '.crabot-desktop-core'), registeredRoot, previousRoot, true)
      if (command?.text !== text) await publish(entry, text, command)
      identity.appendUserPathDirectory(prefix, priorPath)
    } else await link(entry, path.join(registeredRoot, 'bin/crabot'), previousRoot && path.join(previousRoot, 'bin/crabot'))
    for (const change of changes) await publish(change.file, change.text, change.previous)
    await publish(metadata, JSON.stringify(paired ? { schema_version: 2, install_root: registeredRoot } : { schema_version: 1, core_root: coreRoot }) + '\n', previous)
    shellFiles = changes.map(change => change.file)
  } finally { releaseCliLock(lock) }
  // OS notification can wait on unrelated windows; registration is complete and
  // service start/stop must be able to use the lifecycle lock during that wait.
  const notificationSent = windows ? await notifyCliPathChange(coreRoot, env) : true
  return { command: entry, shell_files: shellFiles, notification_sent: notificationSent }
}
