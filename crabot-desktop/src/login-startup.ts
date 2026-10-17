import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { App } from 'electron'

const marker = 'X-Crabot-Managed=true'
export type StartupState = { supported: boolean; enabled: boolean; approvalRequired: boolean }

// OS settings are the source of truth. Construction/reading never enrolls the app.
export class LoginStartup {
  constructor(private readonly options: { platform: string; packaged: boolean; executable: string; configHome: string;
    app: Pick<App, 'getLoginItemSettings' | 'setLoginItemSettings'> }) {}
  private file() { return path.join(this.options.configHome, 'autostart', 'crabot.desktop') }
  private async linuxEntry(): Promise<string | null> {
    try {
      const stat = await lstat(this.file())
      if (!stat.isFile() || stat.size > 16_384) throw new Error('已有登录启动项无法识别，未作修改。')
      const text = await readFile(this.file(), 'utf8')
      if (!text.split(/\r?\n/).includes(marker)) throw new Error('已有登录启动项不属于桌面版，请先完成旧安装接管。')
      return text
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  async get(): Promise<StartupState> {
    const { platform, packaged, app, executable } = this.options
    if (!packaged) return { supported: false, enabled: false, approvalRequired: false }
    if (platform === 'linux') {
      const text = await this.linuxEntry()
      const lines = text?.split(/\r?\n/) ?? []
      return { supported: true, enabled: !!text && !lines.includes('Hidden=true') && !lines.includes('X-GNOME-Autostart-enabled=false'), approvalRequired: false }
    }
    const state = app.getLoginItemSettings(platform === 'win32' ? { path: executable, args: ['--background'] } : {})
    const approvalRequired = platform === 'darwin' && state.status === 'requires-approval'
    const ownWindowsEntry = platform !== 'win32' || state.launchItems.some(item => item.name === 'Crabot' && item.scope === 'user'
      && item.path.toLowerCase() === executable.toLowerCase() && JSON.stringify(item.args) === '["--background"]' && item.enabled)
    return { supported: true, enabled: state.openAtLogin && !approvalRequired && ownWindowsEntry, approvalRequired }
  }
  async set(enabled: boolean): Promise<StartupState> {
    const { platform, packaged, app, executable } = this.options
    if (!packaged) throw new Error('源码开发模式不修改系统登录启动项。')
    if (platform === 'linux') {
      await this.linuxEntry() // Refuse unrelated files before making any change.
      if (!enabled) await rm(this.file(), { force: true })
      else {
        if (/[\r\n\0=]/.test(executable)) throw new Error('应用路径不能用于登录启动。')
        // Exec quoting is desktop-entry syntax, not shell syntax. Literal percent
        // must be doubled; backslashes pass through both string and Exec parsing.
        const quoted = executable.replace(/\\/g, '\\\\\\\\').replace(/"/g, '\\\\"').replace(/`/g, '\\\\`').replace(/\$/g, '\\\\$').replace(/%/g, '%%')
        const text = `[Desktop Entry]\nType=Application\nName=Crabot\nExec="${quoted}" --background\nTerminal=false\nX-GNOME-Autostart-enabled=true\n${marker}\n`
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
  launchedAtLogin(): boolean {
    return this.options.packaged && this.options.platform === 'darwin' && this.options.app.getLoginItemSettings().wasOpenedAtLogin
  }
}
