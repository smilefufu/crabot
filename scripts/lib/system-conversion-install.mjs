// Installer routing only. Employee I/O, shutdown, backup and selection belong to
// the existing dropped-UID conversion job, never to this root installer.
import { promises as fs, openSync, closeSync } from 'node:fs'
import { ReadStream, isatty } from 'node:tty'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { isDeepStrictEqual } from 'node:util'
import { installStandaloneCli } from './standalone-cli-install.mjs'
import { verifyCoreRelease } from './core-release.mjs'
import { discoverLegacySystemRelease } from './legacy-system-release.mjs'
import cliLocation from './cli-location.cjs'
import { verifyRootDirectory } from './system-user.mjs'
import { LegacySystemEntryFence } from './legacy-system-fence.mjs'
import { LegacySystemCommandLink } from './legacy-system-command.mjs'
import { readLegacySystemHints } from './legacy-system-hints.mjs'
import { preflightLegacySystemConversion } from './system-conversion-preflight.mjs'
import { planSystemConversion, validateSystemConversionPlan } from './system-conversion.mjs'
import { SystemRegistry, systemError } from './system-registry.mjs'
import { SystemOperationStore } from './system-operation.mjs'
import { systemdAvailable } from './system-service.mjs'
import { submitSystemOperation } from './system-job-client.mjs'
async function present(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
export async function confirmSystemConversion() {
  let input = process.stdin, ownedInput
  if (!input.isTTY) {
    let fd
    try {
      fd = openSync('/dev/tty', 'r')
      if (!isatty(fd)) throw Error('Not a terminal')
      input = ownedInput = new ReadStream(fd)
    } catch {
      if (fd !== undefined) closeSync(fd)
      throw systemError('发现旧system部署。请在交互终端重新运行安装器并确认一次维护；未停止实例或修改原数据。')
    }
  }
  const prompt = createInterface({ input, output: process.stdout })
  try { return /^y(es)?$/i.test((await prompt.question('确认转换并维护重启原运行实例？[y/N] ')).trim()) }
  finally { prompt.close(); ownedInput?.destroy() }
}

// Overrides are current-UID filesystem fixtures, never command-line options.
export async function installSystemCore({ sourceRoot, installRoot, version, registry = new SystemRegistry(),
  store = new SystemOperationStore(registry), command = new LegacySystemCommandLink(), install = installStandaloneCli,
  fence = new LegacySystemEntryFence(), checkRoot = verifyRootDirectory, available = systemdAvailable, discoverRelease = discoverLegacySystemRelease, readHints = readLegacySystemHints,
  preflight = preflightLegacySystemConversion, confirm = confirmSystemConversion, submit = submitSystemOperation, log = console.log }) {
  registry.authority(); installRoot = path.resolve(installRoot)
  let legacyRoot
  if (await present(path.join(installRoot, 'cli.mjs'))) legacyRoot = installRoot
  else if ((await present(command.command))?.isSymbolicLink()) {
    const target = path.resolve(path.dirname(command.command), await fs.readlink(command.command))
    if (path.basename(target) === 'cli.mjs') legacyRoot = path.dirname(target)
  }
  if (!legacyRoot) return install({ sourceRoot, installRoot, version, scope: 'system' })
  if (!available()) throw systemError('旧system转换需要可用systemd，原部署保持；未进入维护。', 'CRABOT_SYSTEMD_UNAVAILABLE')
  const targetRoot = installRoot === legacyRoot ? path.join(installRoot, '.managed') : installRoot
  if (await present(path.join(legacyRoot, '.system-takeover'))) {
    const previous = await fence.inspect(legacyRoot)
    if (previous.phase !== 'restored') {
      const job = store.read(store.file(previous.operation_id), true)
      store.assertIdle()
      const plan = validateSystemConversionPlan(job?.plan)
      if (previous.phase !== 'data_changing' || !previous.entries_fenced || job.phase !== 'completed'
        || plan.id !== previous.operation_id || job.progress?.id !== plan.id || job.progress.source_fence_id !== previous.id
        || job.progress?.phase !== 'completed' || job.progress.exit_code !== 0 || plan.install_root !== targetRoot
        || !isDeepStrictEqual(previous.installation, plan.source)) throw systemError('旧转换尚未完成，保留原保护；请通过已准备管理入口运行system status核对。')
      const id = cliLocation.readCliSelection(targetRoot)
      if (!id) throw systemError('已有转换的受管版本定位缺失，原数据保留，请修复安装。')
      const coreRoot = path.join(targetRoot, 'releases', id)
      const current = await verifyCoreRelease(coreRoot)
      const selectedPlan = { ...plan, target: { id, version: current.version } }
      if (await command.selected(selectedPlan) !== 'target') throw systemError('已有转换的共享命令发生变化，未覆盖。')
      return { ...await install({ sourceRoot, installRoot: targetRoot, version, scope: 'system' }), converted: true }
    }
  }
  const source = await discoverRelease({ root: legacyRoot })
  if (await present(registry.directory)) {
    if (registry.read().length) throw systemError('已有受管用户，未混入另一份旧部署。')
    store.assertIdle()
  }
  // Do not adopt a pre-existing directory merely because it has the right name.
  if (await present(targetRoot)) {
    await checkRoot(targetRoot)
    const files = await fs.readdir(targetRoot)
    if (!files.includes('cli-installation.json') || !files.includes('current-core')) throw systemError('新版准备目录已存在但无法核实归属，已保留；未停止旧实例。')
  }
  const release = await verifyCoreRelease(sourceRoot, { version })
  const preview = planSystemConversion({ installRoot: targetRoot, source,
    target: { id: release.inventory_sha256, version: release.version }, instances: [] })
  if (await command.selected(preview) !== 'legacy') throw systemError('共享命令并非原部署入口，未开始转换。')
  log('发现旧system部署 ' + source.version + '，正在准备完整新版；现有实例继续运行。')
  const prepared = await install({ sourceRoot, installRoot: targetRoot, scope: 'system', version })
  const result = await preflight({ root: prepared.coreRoot, sourceRoot: source.installRoot, registry })
  const plan = result.plan
  if (plan.install_root !== prepared.installRoot || plan.target.id !== prepared.id || plan.target.version !== prepared.version
    || !isDeepStrictEqual(plan.source, source)) throw systemError('转换预检来源或目标变化，未进入维护。')
  await command.target(plan)
  log('旧system转换 ' + source.version + ' → ' + prepared.version + '；' + plan.instances.length + '个用户。原数据和端口保持，按本人备份实际迁移的配置/数据库。')
  for (const { entry, observation } of plan.instances) log(entry.user + '\t' + (observation.runtime_state === 'running' ? '维护停机后恢复' : '保持停止'))
  log('已准备管理入口：' + prepared.command + ' system status；SSH断线后可用此入口检查作业。')
  if (!await confirm()) throw systemError('已取消转换，旧实例和数据保持；准备载荷已保留。')
  if (readHints().fingerprint !== result.hints_fingerprint || await command.selected(plan) !== 'legacy') throw systemError('确认期间旧注册提示或共享命令已变化，请重新预检；未停止实例。')
  await registry.update(entries => {
    if (entries.length) throw systemError('确认期间受管用户集合已变化，未覆盖。')
    store.assertIdle(); return entries
  }, { create: true })
  const code = await submit(plan, { root: prepared.coreRoot, store, log })
  if (code !== 0) throw systemError('转换未完全成功，原记录和保护已保留；请运行 ' + prepared.command + ' system status 核对。')
  return { ...prepared, converted: true }
}
