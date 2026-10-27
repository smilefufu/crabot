import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { App } from 'electron'
import type { LoginStartupIntent } from './login-startup-update.js'

const marker = 'X-Crabot-Managed=true'
export type StartupState = { supported: boolean; enabled: boolean; approvalRequired: boolean }

function ubuntuStartupCommand(executable: string): string {
  if (/[\r\n\0=]/.test(executable)) throw new Error('应用路径不能用于登录启动。')
  // Exec quoting is desktop-entry syntax, not shell syntax. Literal percent
  // must be doubled; backslashes pass through both string and Exec parsing.
  const quoted = executable.replace(/\\/g, '\\\\\\\\').replace(/"/g, '\\\\"').replace(/`/g, '\\\\`').replace(/\$/g, '\\\\$').replace(/%/g, '%%')
  // GIO validates argv[0] before expanding %% to a literal percent. Keep
  // its executable fixed; env forwards the expanded path without a shell.
  return `Exec=/usr/bin/env -- "${quoted}" --background`
}
export function ubuntuLoginStartupEntry(executable: string): string {
  return `[Desktop Entry]\nType=Application\nName=Crabot\n${ubuntuStartupCommand(executable)}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n${marker}\n`
}

// OS settings are the source of truth. Construction/reading never enrolls the app.
export class LoginStartup {
  constructor(private readonly options: { platform: string; packaged: boolean; executable: string; configHome: string;
    app: Pick<App, 'getLoginItemSettings' | 'setLoginItemSettings'>; retargetWindows?: (source: string, target: string) => void | Promise<void>;
    inspectWindows?: (executable: string) => 'absent' | 'different' | 'background' | 'custom' }) {}
  private file() { return path.join(this.options.configHome, 'autostart', 'crabot.desktop') }
  private async linuxEntry(executables = [this.options.executable]): Promise<string | null> {
    try {
      const stat = await lstat(this.file())
      if (!stat.isFile() || stat.size > 16_384) throw new Error('已有登录启动项无法识别，未作修改。')
      const text = await readFile(this.file(), 'utf8')
      const lines = text.split(/\r?\n/)
      if (!lines.includes(marker)) throw new Error('已有登录启动项不属于桌面版，请先完成旧安装接管。')
      if (!executables.some(executable => lines.filter(line => line.startsWith('Exec=')).join('\n') === ubuntuStartupCommand(executable))
        || lines.filter(line => line.startsWith('[')).join('\n') !== '[Desktop Entry]') {
        throw new Error('已有登录启动项与当前应用不一致，已保留。请先完成旧安装接管或检查系统设置。')
      }
      return text
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  private windowsSettings(executable: string) {
    if (/["\r\n\0]/.test(executable)) throw new Error('应用路径不能用于登录启动。')
    // Electron 44 parses lookup path as a command line; quote spaced paths.
    return this.options.app.getLoginItemSettings({ path: `"${executable}"`, args: ['--background'] })
  }
  async get(): Promise<StartupState> {
    const { platform, packaged, app, executable } = this.options
    if (!packaged) return { supported: false, enabled: false, approvalRequired: false }
    if (platform === 'linux') {
      const text = await this.linuxEntry()
      const lines = text?.split(/\r?\n/) ?? []
      return { supported: true, enabled: !!text && !lines.includes('Hidden=true') && !lines.includes('X-GNOME-Autostart-enabled=false'), approvalRequired: false }
    }
    if (platform === 'win32') {
      const command = this.windowsCommand(executable), state = this.windowsSettings(executable)
      const enabled = command === 'background' && state.launchItems.some(item => item.name === 'Crabot' && item.scope === 'user'
        && item.path.toLowerCase() === executable.toLowerCase() && item.enabled)
      if (this.windowsCommand(executable) !== command) throw new Error('登录启动命令发生变化，请重新核对。')
      return { supported: true, enabled, approvalRequired: false }
    }
    const state = app.getLoginItemSettings()
    const approvalRequired = state.status === 'requires-approval'
    return { supported: true, enabled: !!state.openAtLogin && !approvalRequired, approvalRequired }
  }
  async set(enabled: boolean): Promise<StartupState> {
    const { platform, packaged, app, executable } = this.options
    if (!packaged) throw new Error('源码开发模式不修改系统登录启动项。')
    if (platform === 'linux') {
      await this.linuxEntry() // Refuse unrelated files before making any change.
      if (!enabled) await rm(this.file(), { force: true })
      else {
        const text = ubuntuLoginStartupEntry(executable)
        await mkdir(path.dirname(this.file()), { recursive: true })
        const temporary = this.file() + '.tmp-' + randomUUID()
        try { await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await rename(temporary, this.file()) }
        finally { await rm(temporary, { force: true }) }
      }
    } else app.setLoginItemSettings({ openAtLogin: enabled, ...(platform === 'win32' ? { path: executable, args: ['--background'], enabled, name: 'Crabot' } : {}) })
    const state = await this.get()
    if (state.enabled !== enabled && !state.approvalRequired) throw new Error('系统未确认登录启动设置，请检查系统设置。')
    return state
  }
  private windowsCommand(executable: string) {
    const inspect = this.options.inspectWindows ?? createRequire(import.meta.url)('./bootstrap/scripts/lib/process-identity.cjs').inspectDesktopLoginStartup
    if (typeof inspect !== 'function') throw new Error('内置登录启动能力缺失，请修复安装。')
    const command = inspect(executable)
    if (!['absent', 'different', 'background', 'custom'].includes(command)) throw new Error('登录启动命令无法核验。')
    return command
  }
  private windowsEntry(executable: string) {
    const command = this.windowsCommand(executable), state = this.windowsSettings(executable)
    if (command === 'custom' || state.launchItems.length > 1 || state.launchItems.some(item => item.name !== 'Crabot' || item.scope !== 'user'
      || item.path.toLowerCase() !== executable.toLowerCase()) || (command === 'background') !== (state.launchItems.length === 1)
      || this.windowsCommand(executable) !== command) {
      throw new Error('已有登录启动项与当前应用不一致，已保留。请检查系统设置。')
    }
    return state.launchItems[0] ?? null
  }
  async captureForUpdate(): Promise<LoginStartupIntent> {
    if (!this.options.packaged) throw new Error('开发模式不建立登录启动更新记录。')
    if (this.options.platform === 'win32') {
      if (this.windowsCommand(this.options.executable) === 'different') throw new Error('已有登录启动项属于另一应用，未开始更新。')
      return this.windowsEntry(this.options.executable)?.enabled ? 'on' : 'off'
    }
    if (this.options.platform === 'darwin') {
      const state = this.options.app.getLoginItemSettings()
      if (state.status === 'not-found') {
        if (state.openAtLogin === false) return 'off'
        throw new Error('系统无法识别当前应用的登录启动状态，未开始更新。')
      }
    }
    const state = await this.get()
    if (!state.supported) throw new Error('当前平台不支持登录启动。')
    return state.approvalRequired ? 'approval_required' : state.enabled ? 'on' : 'off'
  }
  async restoreForUpdate(intent: LoginStartupIntent, sourceExecutable: string): Promise<StartupState> {
    const { platform, packaged, executable, app } = this.options
    if (!packaged || !['off', 'on', 'approval_required'].includes(intent)
      || !(platform === 'win32' ? path.win32 : path.posix).isAbsolute(sourceExecutable) || sourceExecutable.includes('\0')) {
      throw new Error('登录启动恢复上下文无法核验，系统设置已保留。')
    }
    if (platform === 'linux') {
      if (intent === 'approval_required') throw new Error('登录启动恢复状态与当前平台不一致。')
      const text = await this.linuxEntry([executable, sourceExecutable])
      if (!text) {
        if (intent === 'on') throw new Error('原登录启动项已不存在，未自动重新开启。请检查系统设置。')
        return this.get()
      }
      const lines = text.split(/\r?\n/)
      if (lines.includes(ubuntuStartupCommand(this.options.executable))) return this.get()
      const enabled = !lines.includes('Hidden=true') && !lines.includes('X-GNOME-Autostart-enabled=false')
      if (intent === 'off' && enabled) throw new Error('登录启动选择已改变，原入口已保留。请检查系统设置。')
      const replacement = text.replace(ubuntuStartupCommand(sourceExecutable), ubuntuStartupCommand(this.options.executable))
      const temporary = this.file() + '.tmp-' + randomUUID()
      try {
        await writeFile(temporary, replacement, { flag: 'wx', mode: 0o600 })
        if (await this.linuxEntry([executable, sourceExecutable]) !== text) throw new Error('登录启动项发生变化，未替换。')
        try { await rename(temporary, this.file()) }
        catch (error) { if (await this.linuxEntry() !== replacement) throw error }
      } finally { await rm(temporary, { force: true }) }
      if (await this.linuxEntry() !== replacement) throw new Error('登录启动入口替换结果尚未确认。')
      return this.get()
    }
    if (platform === 'win32') {
      if (intent === 'approval_required') throw new Error('登录启动恢复状态与当前平台不一致。')
      if (this.windowsEntry(executable)) return this.get()
      const source = this.windowsEntry(sourceExecutable)
      if (!source) {
        if (intent === 'on') throw new Error('原登录启动项无法核验，未自动创建或覆盖。请检查系统设置。')
        return this.get()
      }
      if (intent === 'off' && source.enabled) throw new Error('登录启动选择已改变，原入口已保留。请检查系统设置。')
      // Electron's setter rewrites StartupApproved even when enabled is omitted.
      // The fixed current-user native operation changes only the known Run value.
      const retarget = this.options.retargetWindows ?? ((source: string, target: string) => {
        const native = createRequire(import.meta.url)('./bootstrap/scripts/lib/process-identity.cjs')
        if (typeof native.retargetDesktopLoginStartup !== 'function') throw new Error('内置登录启动能力缺失，请修复安装。')
        native.retargetDesktopLoginStartup(source, target)
      })
      try { await retarget(sourceExecutable, executable) }
      catch { /* A lost OS reply is resolved by exact readback below. */ }
      const target = this.windowsEntry(executable)
      if (!target) throw new Error('登录启动入口替换结果尚未确认，请检查系统设置。')
      return this.get()
    }
    if (platform !== 'darwin') throw new Error('当前平台不支持登录启动。')
    const current = app.getLoginItemSettings()
    if (current.status === 'not-found') {
      if (intent === 'off' && current.openAtLogin === false) return this.get()
      throw new Error('系统无法识别当前应用，登录启动设置已保留。')
    }
    if (intent !== 'on' || current.openAtLogin || current.status === 'requires-approval') return this.get()
    if (current.status !== 'not-registered') throw new Error('系统登录启动状态无法核验。')
    // This is the verified target application, never an old GUI registering a
    // different bundle. One attempt; an unknown reply is followed by a read.
    try { app.setLoginItemSettings({ openAtLogin: true }) }
    catch { /* Preserve pending intent unless OS readback proves completion. */ }
    const result = await this.get()
    if (!result.enabled && !result.approvalRequired) throw new Error('登录启动结果尚未确认，请检查系统设置。')
    return result
  }
  launchedAtLogin(): boolean {
    return this.options.packaged && this.options.platform === 'darwin' && this.options.app.getLoginItemSettings().wasOpenedAtLogin
  }
}
