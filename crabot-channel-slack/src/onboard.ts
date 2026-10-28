import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { WebClient, LogLevel } from '@slack/web-api'
import { validateInstanceId, type ProxyConfig, type Onboarder, type OnboarderBeginResult, type OnboarderEvent, type OnboarderFinishResult } from 'crabot-shared'
import { ensureCli, privateDirectory, recoverSession, startCli, writePrivate, type CliJob } from './cli-tools.js'
import { prepareProject } from './cli-project.js'
export class OnboardingError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message) }
}
interface Identity { team_id: string; user_id: string }
interface Credentials { bot_token: string; app_token: string }
interface Session {
  id: string; root: string; project: string; executable: string; ticket?: string
  expires: number; phase: 'waiting' | 'processing' | 'ready' | 'error' | 'cancelled' | 'completed'
  abort: AbortController; job?: CliJob; task?: Promise<void>; result?: OnboarderFinishResult
  error?: { code: string; message: string }; app_id?: string; requested_name?: string; proxy?: ProxyConfig
}
interface Options {
  dataDir?: string
  ensureCli?: typeof ensureCli
  startCli?: typeof startCli
  verify?: (credentials: Credentials, identity: Identity, appId: string, signal?: AbortSignal) => Promise<string | void>
  waitMs?: number
  configureMs?: number
}
const logger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {} }
async function verifyCredentials(credentials: Credentials, identity: Identity, appId: string, signal?: AbortSignal): Promise<string | undefined> {
  if (!/^xoxb-[A-Za-z0-9-]+$/.test(credentials.bot_token) || !/^xapp-[A-Za-z0-9-]+$/.test(credentials.app_token)) throw new Error('Invalid handoff')
  const client = new WebClient(credentials.bot_token, { logger, timeout: 15000, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, fetch: (url, init) => fetch(url, { ...init, signal: signal && init?.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init?.signal }) })
  const auth = await client.auth.test()
  const bot = await client.bots.info({ bot: auth.bot_id! })
  if (auth.team_id !== identity.team_id || bot.bot?.app_id !== appId) throw new Error('Installation mismatch')
  try {
    const profile = await client.users.info({ user: identity.user_id })
    return profile.user?.profile?.display_name || profile.user?.real_name || profile.user?.name
  } catch { return undefined } // Display name is optional; the verified platform identity is retained.
}
export class SlackOnboarder implements Onboarder {
  private sessions = new Map<string, Session>()
  private begins = new Set<Promise<OnboarderBeginResult>>()
  private timer?: ReturnType<typeof setInterval>
  private preparation?: Promise<string>
  private disposed = false
  constructor(private readonly options: Options = {}) {}
  private get dataDir() {
    const value = this.options.dataDir ?? process.env.DATA_DIR
    if (!value) throw new Error('Slack 本地授权缺少实例数据目录')
    return value
  }
  private args(session: Session, args: string[]) { return [...args, '--skip-update', '--no-color', '--config-dir', path.join(session.root, 'cli')] }
  private launch(session: Session, args: string[]): CliJob {
    session.abort.signal.throwIfAborted()
    const job = (this.options.startCli ?? startCli)(session.executable, this.args(session, args), session.project, session.proxy)
    session.job = job
    return job
  }
  private async command(session: Session, args: string[]): Promise<string> {
    const job = this.launch(session, args)
    const result = await job.result
    if (session.job === job) session.job = undefined
    session.abort.signal.throwIfAborted()
    if (result.code !== 0) {
      let code = 'unknown'
      if (/expired|invalid_ticket/i.test(result.output)) code = 'expired_token'
      else if (/denied|not_allowed|restricted|approval|permission|scope/i.test(result.output)) code = 'access_denied'
      throw new OnboardingError(code, 400, 'Slack 授权或安装未完成')
    }
    return result.output
  }
  begin(params?: Record<string, unknown>): Promise<OnboarderBeginResult> {
    const task = this.beginSession(params)
    this.begins.add(task)
    void task.finally(() => this.begins.delete(task)).catch(() => {})
    return task
  }
  private async beginSession(params?: Record<string, unknown>): Promise<OnboarderBeginResult> {
    const proxy = params?.__admin_proxy as ProxyConfig | undefined
    if (proxy && !['system', 'custom', 'none'].includes(proxy.mode)) throw new OnboardingError('invalid_input', 400, '网络配置无效')
    const name = params?.instance_name
    if (name !== undefined && (typeof name !== 'string' || !validateInstanceId(name).ok)) throw new OnboardingError('invalid_input', 400, '渠道名称无效')
    if (this.disposed) throw new Error('Slack 授权服务已停止')
    const base = path.join(this.dataDir, 'slack-onboarding')
    await privateDirectory(base)
    // Previous Admin sessions cannot be resumed. Their supervisors stop on IPC disconnect.
    for (const entry of await fs.readdir(base, { withFileTypes: true })) {
      const old = this.sessions.get(entry.name)
      if (!entry.isDirectory() || (old && !['error', 'cancelled', 'completed'].includes(old.phase)) || !/^[0-9a-f-]{36}$/.test(entry.name)) continue
      await recoverSession(path.join(base, entry.name))
      await this.cleanSecrets(path.join(base, entry.name))
      this.sessions.delete(entry.name)
    }
    const id = randomUUID(), root = path.join(base, id)
    await privateDirectory(root)
    await privateDirectory(path.join(root, 'cli'))
    const session: Session = { id, root, project: '', executable: '', expires: Date.now() + 300000, phase: 'processing', abort: new AbortController(), requested_name: typeof name === 'string' ? name : undefined, proxy }
    if (this.disposed) throw new Error('Slack 授权服务已停止')
    this.sessions.set(id, session)
    const timeout = setTimeout(() => session.abort.abort(), 300000)
    const abortJob = () => { void session.job?.stop().catch(() => {}) }
    session.abort.signal.addEventListener('abort', abortJob)
    try {
      this.preparation ??= (this.options.ensureCli ?? ensureCli)(this.dataDir, session.abort.signal).catch(error => { this.preparation = undefined; throw error }).finally(() => { this.preparation = undefined })
      session.executable = await this.preparation
      session.abort.signal.throwIfAborted()
      session.project = await prepareProject(root)
      const output = await this.command(session, ['auth', 'login', '--no-prompt'])
      const ticket = output.match(/\/slackauthticket\s+([A-Za-z0-9_+/=-]+)/)?.[1]
      if (!ticket) throw new Error('CLI did not return ticket')
      session.ticket = ticket
      session.phase = 'waiting'
      session.expires = Date.now() + (this.options.waitMs ?? 600000)
      return { session_id: id, ui_mode: 'challenge_code', authorization_command: `/slackauthticket ${ticket}`, expires_at: session.expires, display: { title: '在 Slack 确认授权', description: '在目标 workspace 发送命令，确认授权后将验证码填回。Crabot 自动创建和安装本地 App。' } }
    } catch {
      await this.fail(session)
      throw new Error(`Slack 本地授权准备失败（网络模式：${proxy?.mode ?? 'system'}）；请检查当前网络/代理、工具路径和系统权限后重新开始`)
    } finally { clearTimeout(timeout) }
  }
  private getSession(id: string): Session {
    const session = this.sessions.get(id)
    if (!session || (session.phase === 'waiting' && Date.now() >= session.expires)) {
      if (session) this.cancel(id)
      throw new OnboardingError('session_not_found', 404, '授权会话不存在或已过期')
    }
    return session
  }
  async submit(id: string, input: { challenge_code: string }): Promise<void> {
    const code = input?.challenge_code
    if (typeof code !== 'string' || !code.trim() || /[\x00-\x20\x7f]/.test(code) || code.length > 256) throw new OnboardingError('invalid_input', 400, '请输入有效的一次性验证码')
    const session = this.getSession(id)
    if (session.phase === 'processing') throw new OnboardingError('session_busy', 409, '正在配置，请等待')
    if (session.phase !== 'waiting') throw new OnboardingError('session_completed', 409, '本轮授权已结束')
    session.phase = 'processing'
    session.expires = Date.now() + (this.options.configureMs ?? 300000)
    session.task = this.configure(session, code).catch(error => this.fail(session, error))
    void session.task.catch(() => {})
  }
  private async configure(session: Session, code: string): Promise<void> {
    const timer = setTimeout(() => session.abort.abort(), this.options.configureMs ?? 300000)
    try {
      await this.command(session, ['auth', 'login', '--no-prompt', '--ticket', session.ticket!, '--challenge', code])
      session.ticket = undefined
      const auths = JSON.parse(await fs.readFile(path.join(session.root, 'cli', 'credentials.json'), 'utf8')) as Record<string, Identity>
      const values = Object.values(auths)
      if (values.length !== 1 || !/^T[A-Z0-9]+$/.test(values[0].team_id) || !/^U[A-Z0-9]+$/.test(values[0].user_id)) throw new Error('Invalid CLI identity')
      const identity = values[0]
      const previous = await this.previousApp(session, identity)
      if (previous) await writePrivate(path.join(session.project, '.slack', 'apps.dev.json'), { [identity.team_id]: { app_id: previous, team_id: identity.team_id, user_id: identity.user_id, IsDev: true } })
      session.app_id = previous
      await this.recordIntent(session, identity, 'creating')
      const run = this.launch(session, ['run', '--team', identity.team_id, '--app', 'local'])
      let exited = false
      void run.result.finally(() => { exited = true }).catch(() => {})
      let credentials: Credentials | undefined
      while (!credentials) {
        session.abort.signal.throwIfAborted()
        await this.captureApp(session, identity)
        try { credentials = JSON.parse(await fs.readFile(path.join(session.root, 'handoff.json'), 'utf8')) as Credentials }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
        if (!credentials && exited) throw new Error('CLI stopped without credentials')
        if (!credentials) await delay(100, undefined, { signal: session.abort.signal })
      }
      await run.stop() // Do not report success while CLI/hook are alive.
      session.job = undefined
      session.abort.signal.throwIfAborted()
      const apps = JSON.parse(await fs.readFile(path.join(session.project, '.slack', 'apps.dev.json'), 'utf8')) as Record<string, { app_id?: string }>
      const appId = apps[identity.team_id]?.app_id
      if (!appId || !/^A[A-Z0-9]+$/.test(appId)) throw new Error('CLI App identity missing')
      session.app_id = appId
      await this.recordIntent(session, identity, 'configured')
      const displayName = await (this.options.verify ?? verifyCredentials)(credentials, identity, appId, session.abort.signal)
      session.abort.signal.throwIfAborted()
      session.result = { env: { SLACK_BOT_TOKEN: credentials.bot_token, SLACK_APP_TOKEN: credentials.app_token, SLACK_ONLY_RESPOND_TO_MENTIONS: 'true', SLACK_CACHE_MAX_DAYS: '30', SLACK_CACHE_MAX_MESSAGES: '1000' }, authorized_identity: { platform_user_id: identity.user_id, ...(typeof displayName === 'string' && displayName ? { platform_display_name: displayName } : {}) } }
      session.phase = 'ready'
      session.expires = Date.now() + 600000
    } finally { clearTimeout(timer) }
  }
  async *poll(id: string): AsyncIterable<OnboarderEvent> {
    let session: Session
    try { session = this.getSession(id) } catch { yield { type: 'error', code: 'session_not_found' }; return }
    for (;;) {
      if (session.phase === 'ready' || session.phase === 'completed') { yield { type: 'success' }; return }
      if (session.phase === 'error' || session.phase === 'cancelled') { yield { type: 'error', ...session.error ?? { code: 'access_denied', message: '本轮授权已取消' } }; return }
      if (Date.now() >= session.expires) { this.cancel(id); yield { type: 'error', code: 'expired_token' }; return }
      yield { type: 'pending' }
      await delay(500)
    }
  }
  async finish(id: string, params?: Record<string, unknown>): Promise<OnboarderFinishResult> {
    if (typeof params?.created_instance_id === 'string' && !this.sessions.has(id)) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new OnboardingError('session_not_found', 404, '授权会话不存在')
      const root = path.join(this.dataDir, 'slack-onboarding', id)
      const intent = JSON.parse(await fs.readFile(path.join(root, 'intent.json'), 'utf8'))
      if (!intent.app_id || (intent.instance_id && intent.instance_id !== params.created_instance_id)) throw new Error('授权完成记录不一致')
      await this.cleanSecrets(root)
      await writePrivate(path.join(root, 'intent.json'), { ...intent, stage: 'completed', instance_id: params.created_instance_id })
      return { env: {} }
    }
    const session = this.getSession(id)
    if (!session.result || !['ready', 'completed'].includes(session.phase)) throw new OnboardingError('session_completed', 409, '授权尚未成功')
    // Only Admin supplies this internal acknowledgement after durable instance creation.
    if (typeof params?.created_instance_id === 'string') {
      const intent = JSON.parse(await fs.readFile(path.join(session.root, 'intent.json'), 'utf8'))
      await writePrivate(path.join(session.root, 'intent.json'), { ...intent, app_id: session.app_id, instance_id: params.created_instance_id, stage: 'completed' })
      await this.cleanSecrets(session.root)
      session.phase = 'completed'
    }
    return session.result
  }
  private async recordIntent(session: Session, identity: Identity, stage: string) {
    await writePrivate(path.join(session.root, 'intent.json'), { session_id: session.id, requested_name: session.requested_name, team_id: identity.team_id, user_id: identity.user_id, app_id: session.app_id, stage })
  }
  private async captureApp(session: Session, identity: Identity) {
    try {
      const apps = JSON.parse(await fs.readFile(path.join(session.project, '.slack', 'apps.dev.json'), 'utf8'))
      const app = apps[identity.team_id]?.app_id
      if (/^A[A-Z0-9]+$/.test(app ?? '') && app !== session.app_id) { session.app_id = app; await this.recordIntent(session, identity, 'creating') }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  }
  private async previousApp(session: Session, identity: Identity): Promise<string | undefined> {
    if (!session.requested_name) return undefined
    const nameKey = session.requested_name.normalize('NFC').toLowerCase()
    let found: string | undefined
    const base = path.dirname(session.root)
    for (const entry of await fs.readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === session.id || !/^[a-f0-9-]{36}$/.test(entry.name)) continue
      let intent
      try { intent = JSON.parse(await fs.readFile(path.join(base, entry.name, 'intent.json'), 'utf8')) } catch { continue }
      if (intent.stage === 'completed' || (typeof intent.requested_name !== 'string' || intent.requested_name.normalize('NFC').toLowerCase() !== nameKey) || intent.team_id !== identity.team_id || intent.user_id !== identity.user_id) continue
      if (!/^A[A-Z0-9]+$/.test(intent.app_id ?? '')) throw new Error('Previous remote creation outcome unknown; confirm in Slack first')
      if (found && found !== intent.app_id) throw new Error('More than one previous App; confirm in Slack first')
      found = intent.app_id
    }
    return found
  }
  private async cleanSecrets(root: string) {
    for (const name of ['cli', 'handoff.json', 'project', 'hook-state.json']) await fs.rm(path.join(root, name), { recursive: true, force: true })
  }
  private async fail(session: Session, cause?: unknown): Promise<void> {
    session.ticket = undefined
    session.result = undefined
    session.error = { code: session.abort.signal.aborted ? 'expired_token' : cause instanceof OnboardingError ? cause.code : 'unknown', message: `Slack 授权或配置未完成（网络模式：${session.proxy?.mode ?? 'system'}）。请检查当前网络/代理、workspace 安装权限及审批状态后重新授权；若 App 已创建，请先在 https://api.slack.com/apps${session.app_id ? '/' + session.app_id : ''} 核对，避免重复创建。` }
    session.phase = 'error'
    try { await session.job?.stop() } catch { throw new Error('Slack 授权进程清理未确认完成') }
    session.job = undefined
    await this.cleanSecrets(session.root)
  }
  cancel(id: string): void {
    const session = this.sessions.get(id)
    if (!session || session.phase === 'completed') return
    session.phase = 'cancelled'
    session.abort.abort()
    session.task = Promise.resolve(session.task).catch(() => {}).then(() => this.fail(session)).catch(() => {
      session.error = { code: 'unknown', message: '授权进程清理未确认完成；请检查本机进程后重试' }
      throw new Error('Slack 授权进程清理未确认完成')
    })
    void session.task.catch(() => {})
  }
  startGc() {
    this.timer ??= setInterval(() => {
      for (const session of this.sessions.values()) {
        if (Date.now() >= session.expires) {
          if (session.phase === 'completed' || (session.phase === 'error' && !session.job)) { session.result = undefined; this.sessions.delete(session.id) }
          else this.cancel(session.id)
        }
      }
    }, 30000)
    this.timer.unref()
  }
  stopGc() { if (this.timer) clearInterval(this.timer); this.timer = undefined }
  async dispose(): Promise<void> {
    this.disposed = true
    this.stopGc()
    for (const session of this.sessions.values()) this.cancel(session.id)
    await Promise.allSettled([...this.begins])
    const results = await Promise.allSettled([...this.sessions.values()].map(session => session.task))
    if (results.some(result => result.status === 'rejected')) throw new Error('Slack 授权进程清理未确认完成')
    this.sessions.clear()
  }
}
export function createOnboarder(): Onboarder { return new SlackOnboarder() }
