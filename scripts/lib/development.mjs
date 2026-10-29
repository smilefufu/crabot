import { existsSync, realpathSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import { discoverUserSourceDeployment } from './source-installation.mjs'
import { developmentEnvironment, developmentPorts } from './development-environment.mjs'

const failure = message => Object.assign(new Error(message), { code: 'CRABOT_DEV_INSTANCE' })
export async function inspectDevelopment(root) {
  const env = developmentEnvironment(root)
  if (!existsSync(join(env.DATA_DIR, 'instance-runtime.json')) && !existsSync(join(env.DATA_DIR, 'mm.pid'))) return { state: 'stopped', record: null, dataDir: env.DATA_DIR, ports: developmentPorts, logs: join(env.DATA_DIR, 'logs') }
  const { inspectInstance } = await import('./instance-runtime.mjs')
  const current = inspectInstance(env.DATA_DIR)
  const foreign = current.record && (realpathSync(current.record.install_root) !== realpathSync(root) || current.record.mm_port !== developmentPorts.mm)
  if (current.state === 'legacy' || foreign) throw failure('此data属于另一来源或旧启动方式；请先使用原入口停止，开发命令未向它发信号。')
  return { ...current, dataDir: env.DATA_DIR, ports: developmentPorts, logs: join(env.DATA_DIR, 'logs') }
}

// Status adds a bounded health observation; control paths remain identity-only.
export async function readDevelopmentStatus(root) {
  const current = await inspectDevelopment(root)
  const { probeHealthStatus } = await import('./mm-probe.mjs')
  return { ...current, health: current.state === 'running' ? await probeHealthStatus(developmentPorts.mm) : null }
}

// Read only known deployment locations, before changing this source tree.
export async function assertDevelopmentBuildAllowed(root) {
  const current = await inspectDevelopment(root)
  if (current.state !== 'stopped') throw failure('本开发实例仍在运行；请先执行pnpm dev stop，再构建。')
  const { identity } = await import('./instance-runtime.mjs')
  const data = join(homedir(), '.crabot/data')
  let registeredRoot
  try { registeredRoot = JSON.parse(readFileSync(join(data, 'instance-runtime.json'), 'utf8')).install_root }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  if (registeredRoot ? registeredRoot !== realpathSync(root) : discoverUserSourceDeployment()?.root !== realpathSync(root)) return
  if (registeredRoot) {
    const { inspectInstance } = await import('./instance-runtime.mjs')
    if (inspectInstance(data).state !== 'stopped') throw failure('这个源码工作副本仍承载旧部署。请使用独立工作副本开发，或先通过原命令显式停止；原数据与命令保持。')
    return
  }
  let pid
  try { pid = Number(readFileSync(join(data, 'mm.pid'), 'utf8').trim()) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (!Number.isInteger(pid) || pid <= 0) return
  const process_ = identity.inspectProcess(pid)
  if (!process_) return
  const args = identity.inspectProcessArguments(pid)
  const entry = join(root, 'crabot-core/dist/main.js')
  if (args.some(value => { try { return realpathSync(value) === realpathSync(entry) } catch { return false } })) throw failure('这个源码工作副本仍承载旧部署。请使用独立工作副本开发，或先通过原命令显式停止；原数据与命令保持。')
}

export async function assertDevelopmentPortsAvailable() {
  for (const port of Object.values(developmentPorts)) await new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', () => fail(failure(`开发端口${port}已被占用；未停止任何进程，请检查占用或其它开发工作副本。`)))
    probe.listen(port, '127.0.0.1', () => probe.close(done))
  })
}

// The adapter owns only dev location/presentation. Existing layers own actual MM lifecycle.
export async function startDevelopment(root, { foreground = false, lockHeld = false, cleanup = code => { process.exitCode = code }, log = console.log } = {}) {
  const env = developmentEnvironment(root)
  const { acquireStartupLock, releaseCliLock, cliLockToken } = await import('./cli-lock.mjs')
  if (lockHeld && !cliLockToken(join(env.DATA_DIR, 'cli.lock'))) throw failure('开发启动需要持有本实例操作锁。')
  const { prepareCoreEnvironment, applyStartupMigrations } = await import('./core-preparation.mjs')
  const { runCorePreflight } = await import('./core-preflight.mjs')
  const lock = lockHeld ? undefined : await acquireStartupLock(env.DATA_DIR, 'dev-start')
  try {
    if ((await inspectDevelopment(root)).state !== 'stopped') throw failure('本开发实例已经运行；使用pnpm dev status或stop。')
    await assertDevelopmentPortsAvailable()
    const prepared = prepareCoreEnvironment({ root, dataDir: env.DATA_DIR, source: env })
    const preflight = await runCorePreflight({ root, dataDir: env.DATA_DIR, node: process.execPath, env: prepared.env, stdio: 'inherit' })
    if (preflight.exitCode !== 0) throw failure('开发启动前检查失败，原数据保留。')
    await ensureDevelopmentBrowserAccess(root, prepared.env, log)
    await applyStartupMigrations(root, env.DATA_DIR, prepared.env, log)
    delete prepared.env.CRABOT_ADMIN_PASSWORD
    if (!foreground) {
      const { launchBackgroundCore } = await import('./background-core.mjs')
      return await launchBackgroundCore({ root, dataDir: env.DATA_DIR, env: prepared.env, mmPort: developmentPorts.mm, webPort: developmentPorts.web, log })
    }
    const { runManagedCore } = await import('./managed-core.mjs')
    const { probeMmHealthy } = await import('./mm-probe.mjs')
    const result = await runManagedCore({ root, dataDir: env.DATA_DIR, mmPort: developmentPorts.mm, env: prepared.env,
      stdio: ['inherit', 'inherit', 'inherit'], cleanup, log })
    const deadline = Date.now() + 30_000
    while (result.mm.exitCode === null && result.mm.signalCode === null && Date.now() < deadline) {
      if (await probeMmHealthy(developmentPorts.mm)) return result
      await new Promise(done => setTimeout(done, 100))
    }
    throw failure('开发服务尚未就绪；保留运行记录，请用pnpm dev status核对并查看日志。')
  } finally { if (lock) releaseCliLock(lock) }
}

export async function stopDevelopment(root, { lockHeld = false, log = console.log } = {}) {
  const env = developmentEnvironment(root)
  if (!existsSync(env.DATA_DIR)) { log('开发实例未运行。'); return }
  const { acquireCliLock, releaseCliLock, cliLockToken } = await import('./cli-lock.mjs')
  if (lockHeld && !cliLockToken(join(env.DATA_DIR, 'cli.lock'))) throw failure('开发停止需要持有本实例操作锁。')
  const { stopInstance } = await import('./instance-controller.mjs')
  const lock = lockHeld ? undefined : await acquireCliLock(env.DATA_DIR, 'dev-stop')
  try { await inspectDevelopment(root); await stopInstance(env.DATA_DIR, { log }) }
  finally { if (lock) releaseCliLock(lock) }
}

// Preserve the former dev password convention, but materialize a real temporary
// credential so the browser is usable. Production data and existing passwords never change.
export async function ensureDevelopmentBrowserAccess(root, env, log = console.log) {
  const { readCredentials, createCredentialsIfAbsent, newCredentialsFromPassword } = await import(pathToFileURL(join(root, 'crabot-admin/dist/credentials.js')).href)
  const directory = join(env.DATA_DIR, 'admin')
  if (!await readCredentials(directory)) {
    await createCredentialsIfAbsent(directory, await newCredentialsFromPassword(env.CRABOT_ADMIN_PASSWORD, { is_temp: true, changed_via: 'start' }))
    log('本开发环境的浏览器临时密码：admin123；首次登录后请修改。开发GUI不需要此密码。')
  }
}
