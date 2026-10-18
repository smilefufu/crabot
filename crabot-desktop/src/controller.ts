import { existsSync, realpathSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ActivityClient, HttpClient, type DesktopHostState } from 'crabot-client'
import { SessionHost, sameHostContext } from './session-host.js'
import type { UpdateDownload } from './update-dialog.js'

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
    let message = '本机服务尚未就绪。可重新检查连接或查看基础诊断，按提示恢复。'
    if (migration) message = '发现已有部署或数据，需要先检查并确认接管。'
    else if (['CRABOT_CORE_INTEGRITY', 'CRABOT_RUNTIME_INVALID'].includes(code)) message = '内置运行文件未通过校验。请保留数据目录，并使用同版或更高版的桌面安装包修复；修复前先确认共享服务已停止。工作依赖不会因此被清空。'
    else if (['CRABOT_PYTHON_ENV_INVALID', 'CRABOT_PYTHON_ENV_MIGRATION_REQUIRED', 'CRABOT_PYTHON_ENV_SELECTION_INVALID'].includes(code)) message = '工作用Python环境需要单独核验，现有依赖已保留。请打开基础诊断并导出报告；重新安装应用不会自动清空或重建该环境。'
    else if (['CRABOT_BACKUP_SPACE', 'CRABOT_UPDATE_SPACE', 'ENOSPC'].includes(code)) message = '磁盘空间不足，当前步骤未能完成。请保留现有数据和维护记录，释放空间后打开基础诊断核对，再继续操作。'
    else if (code === 'CRABOT_BACKUP_SCOPE_UNVERIFIED') message = '迁移涉及无法确认备份覆盖的数据引用，已停止迁移。请保留现有数据并查看恢复选项。'
    else if (code === 'CRABOT_MIGRATION_INTERRUPTED') message = '上次数据迁移尚未完成，已停止自动重试。原数据、备份和维护记录已保留，请查看基础诊断并按恢复流程处理。'
    else if (['CRABOT_PREFLIGHT_BUSY', 'CRABOT_PREFLIGHT_INTERRUPTED', 'CRABOT_PREFLIGHT_TIMEOUT'].includes(code)) message = '上次启动检查尚未确认结束，检查记录已保留。稍后点击启动可重新核对；只有旧检查进程已结束才会继续，不会清空数据。'
    else if (code === 'CRABOT_INSTANCE_STARTING') message = '服务仍在启动。请稍候重新检查状态，再停止服务。'
    else if (code === 'CRABOT_MAINTENANCE_PENDING') message = '版本更新尚未核验完成。请退出并重新打开 Crabot 检查恢复；仍未恢复时重新安装目标版本，保留现有数据。'
    this.host.status(migration ? 'migration_required' : 'error', message, code)
  }
  fail(error: unknown) { this.report(error) }
  async updateActivity(): Promise<'idle' | 'active' | 'unknown'> {
    try {
      const current = await this.current()
      if (this.host.snapshot().phase === 'stopped' && current.state === 'stopped') {
        const records = await readdir(path.join(this.options.dataRoot, 'module-runtime-registry/records')).catch(error => {
          if (error.code === 'ENOENT') return []; throw error
        })
        return records.some(name => name.endsWith('.json')) ? 'unknown' : 'idle'
      }
      const credential = await this.host.credential()
      if (!credential || !current.mmAlive || credential.generation !== current.record?.generation) return 'unknown'
      const activity = await new ActivityClient(new HttpClient({ endpoint: new URL('/api', credential.admin_url).href,
        token: () => {
          const context = this.host.context()
          if (!context || !sameHostContext(credential, context)) throw new Error('Instance changed')
          return credential.token
        } })).read()
      const context = this.host.context()
      return context && sameHostContext(credential, context) ? activity : 'unknown'
    } catch { return 'unknown' }
  }
  async prepareUpdate(update: UpdateDownload, install: () => Promise<void>): Promise<void> {
    this.busy++
    const pending = this.operation.then(async () => {
      const { acquireCliLock, releaseCliLock } = await this.load('scripts/lib/cli-lock.mjs')
      const maintenance = await this.load('scripts/lib/version-maintenance.mjs')
      const { stopInstance } = await this.load('scripts/lib/instance-controller.mjs')
      const { createMaintenanceBackup } = await this.load('scripts/lib/maintenance-backup.mjs')
      const lock = await acquireCliLock(this.options.dataRoot, 'desktop-update')
      try {
        await this.current()
        if (await this.updateActivity() !== 'idle') throw Object.assign(new Error('Current activity cannot be confirmed idle'), { code: 'CRABOT_UPDATE_BUSY' })
        const record = await maintenance.beginVersionMaintenance(this.options.dataRoot, this.options.coreRoot, update.version, this.options.appVersion)
        this.host.status('stopping', '正在停止共享实例并备份升级所需的数据。')
        await stopInstance(this.options.dataRoot)
        this.host.status('stopped', '共享实例已停止，正在准备版本更新。')
        const backup = await createMaintenanceBackup(this.options.dataRoot)
        await maintenance.recordVersionMaintenanceBackup(this.options.dataRoot, record.id, backup)
        await maintenance.markVersionMaintenanceInstalling(this.options.dataRoot, record.id)
        await install()
      } finally { releaseCliLock(lock) }
    }).catch(error => { this.report(error); throw error })
    this.operation = pending.catch(() => {}).finally(() => { this.busy-- })
    return pending
  }
  recoverVersion(): Promise<boolean> {
    this.busy++
    const pending = this.operation.then(async () => {
      const maintenance = await this.load('scripts/lib/version-maintenance.mjs')
      if (!maintenance.readVersionMaintenance(this.options.dataRoot)) return false
      const { verifyDataCompatibility } = await this.load('scripts/lib/core-preparation.mjs')
      const { assertLocalMigrationData } = await this.load('scripts/lib/maintenance-backup.mjs')
      await maintenance.recoverVersionMaintenance({ dataDir: this.options.dataRoot, root: this.options.coreRoot, appVersion: this.options.appVersion,
        verifyCompatible: async () => {
          const pending = verifyDataCompatibility(this.options.coreRoot, this.options.dataRoot)
          if (pending.length && maintenance.readVersionMaintenance(this.options.dataRoot)?.phase === 'verifying') {
            throw Object.assign(new Error('An earlier migration attempt has an unconfirmed result'), { code: 'CRABOT_MIGRATION_INTERRUPTED' })
          }
          await assertLocalMigrationData(this.options.dataRoot, pending)
        },
        run: async () => { await this.startCore(); return this.host.snapshot().phase === 'ready' } })
      return true
    })
    this.operation = pending.then(() => {}, () => {}).finally(() => { this.busy-- })
    return pending
  }
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
  private async startCore(): Promise<void> {
    this.retries = 0
    await this.verifyInstallation()
    const current = await this.current()
    if (current.state === 'running' && current.mmAlive) { await this.host.reconnect(); return }
    this.host.status('starting', '正在准备内置环境并启动本机服务。')
    const { startDesktopCore } = await this.load('scripts/desktop/start-core.mjs')
    const started = Date.now()
    await startDesktopCore({ root: this.options.coreRoot, dataDir: this.options.dataRoot,
      onStage: (phase: string) => console.info(JSON.stringify({ component: 'desktop-startup', phase, at: new Date().toISOString(), elapsed_ms: Date.now() - started })) })
    await this.host.reconnect()
  }
  start(): Promise<DesktopHostState> { return this.run(() => this.startCore()) }
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
