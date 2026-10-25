import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import cliLocation from './cli-location.cjs'
import { assertCoordinatorStopped } from './system-coordinator.mjs'
import { systemRecoveryOptions } from './system-recovery.mjs'
import { systemdAvailable } from './system-service.mjs'
import { systemConversionRecoveryOperations } from './system-conversion-job.mjs'
import { submitSystemOperation } from './system-job-client.mjs'
import { systemError } from './system-registry.mjs'

export async function recoverSystemOperation({ root, registry, store, args }) {
  if (!systemdAvailable()) throw systemError('作业恢复要求真实systemd；未修改实例。')
  const record = store.read(store.file(args.id), true), maintenance = store.maintenance()
  if (!record) throw systemError('没有找到该管理员作业。')
  console.log('恢复核对 ' + args.id + '：' + record.phase)
  if (maintenance?.id !== args.id) throw systemError('此作业不再持有当前维护保护，未修改其他作业。')
  await assertCoordinatorStopped(record)
  const installation = cliLocation.assertSelectedCli(root), plan = record.plan
  const selected = plan.kind === 'upgrade' ? cliLocation.readCliSelection(plan.install_root) : undefined
  if (['upgrade', 'conversion'].includes(plan.kind) && plan.install_root !== installation?.root) throw systemError('共享作业不属于此安装。')
  const options = systemRecoveryOptions(plan, record.progress, selected)
  if (plan.kind === 'conversion') await systemConversionRecoveryOperations(plan, { root, registry, prior: record.progress })
  for (const item of plan.instances ?? plan.items) {
    try { registry.verifyAccount(item.entry) }
    catch (error) { console.log(item.entry.user + '\t身份核对失败：' + error.message + '；不会对该UID执行变更。'); continue }
    const row = record.progress?.results?.find(value => value.uid === item.entry.uid)
    console.log(item.entry.user + '\t' + (row?.migration_dispatched && !row.migrated ? '迁移结果未知：保持隔离，不重放' : '按原记录与实际状态核对'))
  }
  console.log('可用操作：' + [options.continue && '--continue', options.cancel && '--cancel'].filter(Boolean).join(' / '))
  if (!args.mode) return 0
  if (!options[args.mode]) throw systemError('此阶段不能执行所选恢复方式；未修改实例。')
  if (!args.yes) {
    if (!process.stdin.isTTY) throw systemError('非交互恢复请显式提供--yes；未修改实例。')
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    let answer
    try { answer = await prompt.question('确认' + (args.mode === 'cancel' ? '安全取消准备/未执行部分' : '继续已证明安全的阶段') + '？[y/N] ') } finally { prompt.close() }
    if (!/^y(es)?$/i.test(answer.trim())) throw systemError('已取消恢复核对，原保护和实例状态保持。')
  }
  const prepared = await store.prepareRecovery(args.id, args.mode)
  if (!prepared) { console.log('作业已安全结束，无需重复恢复。'); return 0 }
  const coordinatorRoot = plan.kind === 'upgrade' ? path.join(plan.install_root, 'releases', plan.target.id) : root
  return submitSystemOperation(plan, { root: coordinatorRoot, store, recoveryId: prepared.recovery.id })
}
