import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { updateFailure, type UpdateFailure } from './update-package.js'

export interface UpdateDownload { version: string; file: string; sha512: string; size: number }
export interface PairedUpdateDownload { readonly kind: 'paired'; readonly version: string }
export type UpdateCandidate = UpdateDownload | PairedUpdateDownload
export interface UpdateDriver {
  check(progress: (percent: number) => void): Promise<UpdateCandidate | null>
  install(update: UpdateCandidate): Promise<void>
  close?(): void
}
type UpdateState = { phase: 'idle' | 'checking' | 'current' } | { phase: 'error'; failure: UpdateFailure } | { phase: 'downloading'; percent: number }
  | { phase: 'downloaded' | 'installing'; update: UpdateCandidate }

// Native presentation only. Driver owns trusted downloads; the maintenance
// adapter owns the common lifecycle lock, shutdown, backup and recovery record.
export class UpdateDialog {
  private state: UpdateState = { phase: 'idle' }
  private checking?: Promise<void>
  private presenting?: Promise<boolean>
  private timer?: ReturnType<typeof setInterval>
  private closed = false
  constructor(private readonly options: {
    version: string
    driver: UpdateDriver | null
    configurationError?: boolean
    show: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
    activity: () => Promise<'idle' | 'active' | 'unknown'>
    prepareInstall: (update: UpdateCandidate, install: () => Promise<void>) => Promise<void>
  }) {}
  start() {
    if (!this.options.driver || this.closed) return
    void this.check()
    this.timer ??= setInterval(() => { void this.check() }, 6 * 60 * 60 * 1000)
    this.timer.unref?.()
  }
  private async check() {
    if (!this.options.driver || this.closed || ['downloaded', 'installing'].includes(this.state.phase)) return
    if (this.checking) return this.checking
    this.state = { phase: 'checking' }
    this.checking = (async () => {
      try {
        const update = await this.options.driver!.check(percent => {
          if (!this.closed && Number.isFinite(percent)) this.state = { phase: 'downloading', percent: Math.max(0, Math.min(100, percent)) }
        })
        if (!this.closed) this.state = update ? { phase: 'downloaded', update } : { phase: 'current' }
      } catch (error) { if (!this.closed) this.state = { phase: 'error', failure: updateFailure(error) } }
      finally { this.checking = undefined }
    })()
    return this.checking
  }
  open(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    this.presenting ??= this.present().finally(() => { this.presenting = undefined })
    return this.presenting
  }
  private async present(): Promise<boolean> {
    if (!this.options.driver) {
      await this.options.show({ type: 'info', title: 'Crabot 更新',
        message: this.options.configurationError ? '此安装的更新配置未通过校验。' : '当前构建未启用发行更新。',
        detail: this.options.configurationError ? '未下载或替换应用。请通过官方安装包修复后重试，保留现有数据。' : '开发版和未签名候选包不会自动下载或覆盖安装。', buttons: ['知道了'] })
      return true
    }
    if (this.state.phase === 'idle') void this.check()
    const state = this.state
    const ready = state.phase === 'downloaded'
    const descriptions = { idle: '正在检查更新。', checking: '正在检查更新。', current: '当前已是最新版本。',
      error: '更新检查或下载未完成。当前版本仍可继续使用，请稍后重试。',
      downloading: '正在后台下载更新，任务可以继续运行。', downloaded: '更新已下载，安装前将停止共享服务。',
      installing: '正在准备安装，请稍候。' }
    const failures: Record<UpdateFailure, string> = {
      space: '更新所需空间不足。请释放磁盘空间后重新检查，当前版本和数据保留。',
      integrity: '更新文件完整性校验失败。请重新检查更新以下载文件，当前版本保留。',
      signature: '更新签名未通过校验。请重新获取官方安装包，当前数据保留。',
      metadata: '更新信息无法校验。当前版本保留，请稍后重新检查或获取官方安装包。',
      unavailable: descriptions.error,
    }
    const answer = await this.options.show({ type: ready ? 'question' : 'info', title: 'Crabot 更新',
      message: ready ? `可安装 Crabot ${state.update.version}` : `Crabot ${this.options.version}`,
      detail: (state.phase === 'error' ? failures[state.failure] : descriptions[state.phase]) + (state.phase === 'downloading' ? ` 已下载 ${Math.floor(state.percent)}%。` : ''),
      buttons: ready ? ['稍后', '安装并重启'] : ['关闭', '检查更新'], defaultId: 0, cancelId: 0 })
    if (this.closed || answer.response !== 1) return true
    if (!ready) { void this.check(); return true }
    const activity = await this.options.activity().catch(() => 'unknown' as const)
    if (activity !== 'idle') {
      await this.options.show({ type: 'warning', title: '暂未安装更新', message: activity === 'active' ? '还有正在执行或排队的工作。' : '尚未确认当前工作状态。',
        detail: '更新已保留。请待工作停止并恢复连接后，再打开更新界面安装。', buttons: ['知道了'] })
      return true
    }
    this.state = { phase: 'installing', update: state.update }
    try { await this.options.prepareInstall(state.update, () => this.options.driver!.install(state.update)) }
    catch (error) {
      const failure = updateFailure(error)
      this.state = failure === 'integrity' || failure === 'signature' ? { phase: 'error', failure } : { phase: 'downloaded', update: state.update }
      await this.options.show({ type: 'error', title: '更新尚未完成', message: '未能确认安装完成。',
        detail: (failure === 'unavailable' ? '' : failures[failure] + '\n') + '数据和维护记录已保留。请打开基础诊断检查当前安装，按恢复提示重试或重新安装。', buttons: ['知道了'] })
    }
    return true
  }
  close() { this.closed = true; clearInterval(this.timer); this.options.driver?.close?.() }
}
