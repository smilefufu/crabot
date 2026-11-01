// Copy stopped user data; installation selection and UI stay with the caller.
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import identity from './process-identity.cjs'
import management from './desktop-management.cjs'
import { acquireExistingCliLock, releaseCliLock } from './cli-lock.mjs'
import { inspectInstance } from './instance-runtime.mjs'
import { stopInstance } from './instance-controller.mjs'
import { withVerifiedLegacyProcessGraph } from './legacy-process-graph.mjs'
import { shutdownObservedLegacyRuntime } from './legacy-shutdown.mjs'
import { probeProcessStartIdentity } from './module-process-start.cjs'
import { verifyDataCompatibility } from './data-compatibility.mjs'
import { runMigrations } from '../upgrade-lib/migrate.mjs'
import { runScript } from '../upgrade-lib/runner.mjs'
import product from './product-runtime.cjs'
import { privateJson } from './desktop-preparation-files.mjs'

const within = (parent, child) => { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
async function present(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
const failure = (phase, cause) => Object.assign(new Error(`数据导入在“${phase}”失败：${cause.message}`, { cause }), { code: 'CRABOT_DATA_IMPORT_FAILED', phase })

export async function discoverDesktopDataSource({ root }) {
  root = path.resolve(root)
  if (!await present(root) || await present(path.join(root, '.git'))) return null
  const data = path.join(root, 'data')
  if (!await present(data)) return null
  management.requireExistingDataRoot(data)
  const versionFile = path.join(root, 'VERSION')
  const version = await present(versionFile) ? (await fs.readFile(versionFile, 'utf8')).trim() : '由数据格式判断'
  return { installRoot: await fs.realpath(root), dataRoot: await fs.realpath(data), version }
}

export async function stopDesktopDataSource(source, { signal } = {}) {
  signal?.throwIfAborted()
  const current = inspectInstance(source.dataRoot)
  if (current.record && current.state !== 'stopped') await stopInstance(source.dataRoot)
  else if (current.state === 'legacy') {
    await withVerifiedLegacyProcessGraph(source.installRoot, async (snapshot, rpc) => {
      if (snapshot.state === 'stopped') return
      const agent = await rpc.getDefinition('crabot-agent')
      if (typeof agent.env?.DATA_DIR !== 'string' || await fs.realpath(agent.env.DATA_DIR) !== source.dataRoot) throw new Error('旧服务使用另一份数据，未停止该服务。')
      await shutdownObservedLegacyRuntime(snapshot, rpc,
        () => withVerifiedLegacyProcessGraph(source.installRoot, value => value, { signal }), { signal })
    }, { signal })
  }
  // A dead recorded PID requires no PowerShell. Only a still-live identity needs comparison.
  const records = path.join(source.dataRoot, 'module-runtime-registry/records')
  for (const name of await fs.readdir(records).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
    if (!name.endsWith('.json')) continue
    const record = JSON.parse(await fs.readFile(path.join(records, name), 'utf8'))
    if (identity.inspectProcess(record.root_pid) && await probeProcessStartIdentity(record.root_pid) === record.process_start_identity) {
      throw new Error(`旧模块 ${record.module_id} 仍在运行，未复制数据。`)
    }
  }
}

export async function copyDesktopData(source, target, { signal, progress = () => {} } = {}) {
  source = management.requireExistingDataRoot(source)
  target = path.resolve(target)
  const parent = await fs.realpath(path.dirname(target))
  target = path.join(parent, path.basename(target))
  if (within(source, target) || within(target, source)) throw new Error('来源和目标数据目录不能重叠。')
  const existing = await present(target)
  if (existing && (!(await fs.stat(target)).isDirectory() || (await fs.readdir(target)).some(name => !['cli.lock', 'desktop-profile'].includes(name)))) {
    throw new Error('目标数据目录非空，未覆盖已有数据。')
  }
  management.ensurePrivateDataRoot(target)
  let files = 0, bytes = 0, failure, lastProgress = -Infinity, reportedFiles = 0
  const pending = new Set(), directories = []
  const check = () => { if (failure) throw failure; signal?.throwIfAborted() }
  const report = (final = false) => {
    const now = performance.now()
    if (files !== reportedFiles && (final || now - lastProgress >= 100)) {
      progress({ phase: 'copying', files, bytes })
      lastProgress = now; reportedFiles = files
    }
  }
  async function copy(file, destination) {
    check()
    const info = await fs.lstat(file)
    check()
    if (info.isDirectory()) {
      if (process.platform === 'win32' && identity.isPrivateDirectory(file)) identity.createPrivateDirectory(destination)
      else await fs.mkdir(destination)
      for (const entry of await fs.readdir(file)) await copy(path.join(file, entry), path.join(destination, entry))
      directories.push([destination, info.mode])
    } else {
      while (pending.size >= 8) await Promise.race(pending)
      check()
      const task = (async () => {
        if (process.platform === 'win32' && info.isFile() && identity.isPrivateFile(file)) {
          identity.writePrivateFile(destination, '')
          await fs.copyFile(file, destination)
        } else if (info.isFile()) {
          await fs.copyFile(file, destination, constants.COPYFILE_EXCL)
          await fs.chmod(destination, info.mode)
        } else await fs.cp(file, destination, { verbatimSymlinks: true, mode: constants.COPYFILE_EXCL, errorOnExist: true, force: false })
        if (info.isFile()) { files++; bytes += info.size; if (!failure) report() }
        check()
      })().catch(error => { failure ??= error }).finally(() => pending.delete(task))
      pending.add(task)
    }
  }
  try {
    for (const entry of await fs.readdir(source)) {
      if (!['cli.lock', 'desktop-managed.json', 'desktop-profile'].includes(entry)) await copy(path.join(source, entry), path.join(target, entry))
    }
  } catch (error) { failure ??= error }
  // Drain every write before the caller can release locks, retry, or migrate.
  await Promise.all(pending)
  check()
  for (const [directory, mode] of directories) { await fs.chmod(directory, mode); check() }
  report(true)
  check()
  return { files, bytes }
}

async function prepareImportedData(source, target) {
  // Old process/maintenance receipts describe the source, never the new instance.
  const operational = ['desktop-maintenance.json', 'instance-runtime.json', 'startup-preflight.json', 'mm.pid', 'module-runtime-registry', '.upgrade-migrations', 'agent-python.json', 'agent-venv']
  const history = path.join(target, 'imported-source-state')
  const marker = path.join(source, 'desktop-managed.json')
  if (await present(marker)) {
    management.ensurePrivateDataRoot(history)
    await fs.copyFile(marker, path.join(history, 'desktop-managed.json'), constants.COPYFILE_EXCL)
  }
  for (const name of operational) {
    const file = path.join(target, name)
    if (!await present(file)) continue
    if (name === '.upgrade-migrations') {
      for (const item of await fs.readdir(file)) {
        const state = JSON.parse(await fs.readFile(path.join(file, item, 'state.json'), 'utf8'))
        if (!['completed', 'rolled_back', 'prepared'].includes(state.phase)) throw new Error('来源有尚未确认完成的迁移，请保留原恢复材料。')
      }
    }
    management.ensurePrivateDataRoot(history)
    await fs.rename(file, path.join(history, name))
  }
  const catalog = path.join(target, 'workspace-control/catalog.json')
  if (await present(catalog)) {
    const value = JSON.parse(await fs.readFile(catalog, 'utf8'))
    const relocate = location => typeof location === 'string' && path.isAbsolute(location) && within(source, location)
      ? path.join(target, path.relative(source, location)) : location
    value.storage_root = relocate(value.storage_root)
    for (const workspace of value.workspaces) workspace.root = relocate(workspace.root)
    await fs.writeFile(catalog, JSON.stringify(value) + '\n')
  }
  for (const name of ['admin/admin.pid', 'agent/agent.pid', 'memory/memory.pid']) {
    const file = path.join(target, name)
    if (await present(file)) { management.ensurePrivateDataRoot(history); await fs.rename(file, path.join(history, name.replace('/', '-'))) }
  }
}

export async function importDesktopData({ source, root, target, signal, progress = () => {}, stop = stopDesktopDataSource, migrate, restartCopy = false }) {
  let phase = '检查数据版本', sourceLock, targetLock
  const started = performance.now()
  const report = (next, values = {}) => { phase = next; progress({ phase, elapsed_ms: Math.round(performance.now() - started), ...values }) }
  try {
    if (within(source.dataRoot, path.resolve(target)) || within(path.resolve(target), source.dataRoot)) throw new Error('来源和目标数据目录不能重叠。')
    verifyDataCompatibility(root, source.dataRoot)
    sourceLock = await acquireExistingCliLock(source.dataRoot, 'desktop-data-import')
    report('停止旧服务'); await stop(source, { signal })
    management.ensurePrivateDataRoot(target)
    targetLock = await acquireExistingCliLock(target, 'desktop-data-import')
    if (restartCopy) {
      if (management.readDesktopManagement(target)) throw new Error('数据已初始化，请继续启动，不要重新导入。')
      const migrations = path.join(target, '.upgrade-migrations')
      if (await present(migrations)) for (const name of await fs.readdir(migrations)) {
        const state = JSON.parse(await fs.readFile(path.join(migrations, name, 'state.json'), 'utf8'))
        if (!['prepared', 'rolled_back'].includes(state.phase)) throw new Error('副本已有迁移记录，请保留当前数据并按原迁移记录恢复，未重新复制。')
      }
      for (const name of await fs.readdir(target)) {
        if (!['cli.lock', 'desktop-profile'].includes(name)) await fs.rm(path.join(target, name), { recursive: true, force: true })
      }
    }
    report('复制数据')
    const copied = await copyDesktopData(source.dataRoot, target, { signal, progress: value => progress({ ...value, phase, elapsed_ms: Math.round(performance.now() - started) }) })
    const originalManagement = management.readDesktopManagement(source.dataRoot)
    await prepareImportedData(source.dataRoot, target)
    report('迁移数据', copied)
    if (migrate) await migrate(target)
    else {
      const runtime = product.loadProductRuntime(root, { required: true })
      const env = product.productEnvironment(runtime, target, { ...process.env, CRABOT_HOME: root, DATA_DIR: target, CRABOT_PRODUCT_REQUIRED: '1' })
      const result = await runMigrations(root, target, (script, directory, context) => runScript(script, directory, { ...context, root, env }),
        { info: message => progress({ phase, message }), warn: message => progress({ phase, message }) }, { lockHeld: true })
      if (!result.ok) throw new Error(`迁移失败：${result.failedModule}/${result.failedAt}`)
    }
    await privateJson(path.join(target, 'desktop-managed.json'), originalManagement ?? { schema_version: 1, install_kind: 'desktop', admin_listen_host: '127.0.0.1' })
    report('数据已导入', copied)
    return copied
  } catch (error) { throw failure(phase, error) }
  finally { if (targetLock) releaseCliLock(targetLock); if (sourceLock) releaseCliLock(sourceLock) }
}

// Preserve the old standard Windows command as an alias of the installed native CLI.
export async function forwardImportedWindowsCommand(source, installRoot) {
  if (process.platform !== 'win32') return
  const file = path.join(source.installRoot, 'crabot.cmd')
  if (!await present(file)) return
  const text = await fs.readFile(file, 'utf8')
  if (!/^@echo off/i.test(text) || !/cli\.mjs|Crabot takeover is pending/.test(text)) return
  const executable = path.join(installRoot, 'bin/crabot.exe').replace(/%/g, '%%')
  await fs.writeFile(file, '@echo off\r\n"' + executable + '" %*\r\nexit /b %errorlevel%\r\n')
}
