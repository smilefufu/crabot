import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DesktopHostState } from 'crabot-client'
import { SessionHost } from './session-host.js'

export class DesktopController {
  readonly host: SessionHost
  private operation: Promise<void> = Promise.resolve()
  private busy = 0
  private polling?: ReturnType<typeof setInterval>
  private checking = false
  private retries = 0
  constructor(private readonly options: { coreRoot: string; dataRoot: string; appVersion: string; platform: 'darwin' | 'win32' | 'linux'; packaged?: boolean }) {
    this.host = new SessionHost(options)
  }
  private load(file: string): Promise<any> { return import(pathToFileURL(path.join(this.options.coreRoot, file)).href) }
  private async verifyInstallation() {
    if (this.options.packaged || existsSync(path.join(this.options.coreRoot, 'core-release.json'))) {
      this.host.status('discovering', '正在校验内置组件和应用版本。')
      const { verifyCoreRelease } = await this.load('scripts/lib/core-release.mjs')
      await verifyCoreRelease(this.options.coreRoot, { version: this.options.appVersion })
    }
  }
  private async connect(operation: Promise<void>) {
    await this.verifyInstallation()
    if (this.busy || this.operation !== operation) return
    await this.host.reconnect()
  }
  private report(error: unknown) {
    const value = error as { code?: string }
    const code = typeof value?.code === 'string' && /^[A-Z0-9_]{1,128}$/.test(value.code) ? value.code : 'DESKTOP_UNAVAILABLE'
    const migration = ['CRABOT_DESKTOP_TAKEOVER_REQUIRED', 'CRABOT_DATA_NOT_PRIVATE', 'CRABOT_LEGACY_INSTANCE'].includes(code)
    this.host.status(migration ? 'migration_required' : 'error', migration
      ? '发现已有部署或数据，需要先检查并确认接管。' : '本机服务尚未就绪。可重新检查连接或打开数据目录查看日志。', code)
  }
  fail(error: unknown) { this.report(error) }
  private run(operation: () => Promise<void>): Promise<DesktopHostState> {
    this.busy++
    const pending = this.operation.then(operation).catch(error => { this.report(error) }).finally(() => { this.busy-- })
    this.operation = pending
    return pending.then(() => this.host.snapshot())
  }
  private async current() {
    const { inspectInstance, identity } = await this.load('scripts/lib/instance-runtime.mjs')
    const current = inspectInstance(this.options.dataRoot)
    if (current.state === 'legacy' || current.record && realpathSync(current.record.install_root) !== realpathSync(this.options.coreRoot)) {
      throw Object.assign(new Error('An existing installation requires explicit takeover'), { code: 'CRABOT_DESKTOP_TAKEOVER_REQUIRED' })
    }
    return { ...current, mmAlive: current.record?.mm && identity.sameProcess(current.record.mm, identity.inspectProcess(current.record.mm.pid)) }
  }
  start(): Promise<DesktopHostState> {
    return this.run(async () => {
      this.retries = 0
      await this.verifyInstallation()
      const current = await this.current()
      if (current.state === 'running' && current.mmAlive) { await this.host.reconnect(); return }
      this.host.status('starting', '正在准备内置环境并启动本机服务。')
      const { startDesktopCore } = await this.load('scripts/desktop/start-core.mjs')
      await startDesktopCore({ root: this.options.coreRoot, dataDir: this.options.dataRoot })
      await this.host.reconnect()
    })
  }
  stop(): Promise<DesktopHostState> {
    return this.run(async () => {
      this.host.status('stopping', '正在等待共享实例完成停机。')
      const { acquireCliLock, releaseCliLock } = await this.load('scripts/lib/cli-lock.mjs')
      const { stopInstance } = await this.load('scripts/lib/instance-controller.mjs')
      const lock = await acquireCliLock(this.options.dataRoot, 'desktop-stop')
      try { await this.current(); await stopInstance(this.options.dataRoot) } finally { releaseCliLock(lock) }
      this.host.status('stopped', '服务已停止。可在需要时重新启动。')
    })
  }
  reconnect(): Promise<DesktopHostState> {
    return this.run(async () => {
      this.retries = 0
      await this.verifyInstallation()
      const current = await this.current()
      if (current.state === 'running' && current.mmAlive) await this.host.reconnect()
      else this.host.status('stopped', '服务已停止。重新检查不会自动启动服务。')
    })
  }
  watch() {
    this.polling ??= setInterval(() => {
      if (this.busy || this.checking) return
      this.checking = true
      void this.reconnectIfChanged().finally(() => { this.checking = false })
    }, 5000)
  }
  private async reconnectIfChanged() {
    const operation = this.operation
    try {
      const current = await this.current(), state = this.host.snapshot()
      if (this.busy) return
      if (!current.mmAlive) {
        if (state.phase === 'ready' || state.phase === 'disconnected') this.host.status('stopped', '共享实例已停止。')
      } else if (state.phase === 'stopped') {
        this.retries = 0
        this.host.status('disconnected', '共享实例已启动，正在恢复连接。')
        await this.connect(operation)
      } else if (state.phase === 'ready' && current.record.generation !== state.generation) {
        this.host.status('disconnected', '实例已重新启动，正在恢复连接。')
        await this.connect(operation)
      } else if (state.phase === 'ready') {
        if (await this.host.check()) this.retries = 0
      } else if (state.phase === 'disconnected' && this.retries < 3) { this.retries++; await this.connect(operation) }
    } catch (error) {
      if (!this.busy && this.operation === operation && !['error', 'migration_required'].includes(this.host.snapshot().phase)) this.report(error)
    }
  }
  close() { clearInterval(this.polling); this.host.close() }
}
