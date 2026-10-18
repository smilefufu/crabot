import { createInterface } from 'node:readline/promises'
import cliLocation from './cli-location.cjs'
import { SystemRegistry, systemError } from './system-registry.mjs'
import { SystemOperationStore } from './system-operation.mjs'
import { systemdAvailable } from './system-service.mjs'
import { runSystemUser } from './system-user.mjs'
import { getLatestVersion, getReleaseUrls, downloadRelease } from '../upgrade-lib/release.mjs'
import { prepareDownloadedCliPayload } from './cli-release-preparation.mjs'
import { verifyCoreRelease } from './core-release.mjs'
import { planSystemUpgrade } from './system-upgrade.mjs'
import { submitSystemOperation } from './system-job-client.mjs'

export async function runSystemUpgradeCli({ root, yes, logger }) {
  const registry = new SystemRegistry(); registry.authority()
  const store = new SystemOperationStore(registry); store.assertIdle()
  const source = cliLocation.assertSelectedCli(root)
  if (!source || source.scope !== 'system') throw systemError('旧system部署请先使用新版安装器完成兼容转换。')
  if (!systemdAvailable()) throw systemError('共享协调更新要求真实systemd，未停止任何实例。', 'CRABOT_SYSTEMD_UNAVAILABLE')
  const current = await verifyCoreRelease(root)
  const { tag } = await getLatestVersion()
  if (tag.replace(/^v/, '') === current.version) { logger.info('已是最新版本 ' + current.version); return 0 }
  logger.info('准备新版 ' + tag + '；现有实例继续运行。')
  const artifact = await downloadRelease({ ...getReleaseUrls(tag), logger })
  const prepared = await prepareDownloadedCliPayload({ root, artifact, scope: 'system', logger })
  store.assertIdle()
  const instances = []
  for (const entry of registry.read().filter(value => value.enabled)) {
    registry.verifyAccount(entry)
    instances.push({ entry, observation: await runSystemUser(entry, { root, action: 'inspect' }) })
  }
  const plan = planSystemUpgrade({ installRoot: source.root, source: { id: source.id, version: current.version },
    target: { id: prepared.id, version: prepared.version }, instances })
  logger.info('共享升级 ' + current.version + ' → ' + prepared.version + '；' + instances.length + '个用户，范围备份保存在各自数据目录旁。')
  for (const item of instances) logger.info(item.entry.user + '\t' + item.observation.state + '\t' + (item.observation.state === 'running' ? '短暂停机后恢复' : '保持停止'))
  if (!yes) {
    if (!process.stdin.isTTY) throw systemError('新版已准备，未进入维护；非交互升级请显式提供--yes。')
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    let answer
    try { answer = await prompt.question('确认进入维护窗口并升级？[y/N] ') } finally { prompt.close() }
    if (!/^y(es)?$/i.test(answer.trim())) throw systemError('已取消，未停止任何实例；新版载荷已保留。')
  }
  return submitSystemOperation(plan, { root: prepared.coreRoot, store, log: logger.info })
}
