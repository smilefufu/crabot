import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { parseSystemArguments } from './lib/system-arguments.mjs'
import { SystemRegistry, systemError } from './lib/system-registry.mjs'
import { SystemOperationStore } from './lib/system-operation.mjs'
import { planSystemBatch, requireBatchConfirmation } from './lib/system-batch.mjs'
import { runSystemUser, verifyRootExecutable } from './lib/system-user.mjs'
import { installSystemUserService, ensureSystemUserManager, systemdAvailable } from './lib/system-service.mjs'
import cliLocation from './lib/cli-location.cjs'
import { submitSystemOperation, systemOperationStage } from './lib/system-job-client.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
async function password() {
  process.stdin.setEncoding('utf8')
  if (!process.stdin.isTTY) throw systemError('首次开通请在管理员交互终端设置初始密码；不从命令参数或环境变量读取密码。')
  const ask = prompt => new Promise((resolve, reject) => {
    process.stdout.write(prompt); process.stdin.setRawMode(true); process.stdin.resume()
    let value = ''
    const onData = bytes => {
      for (const character of bytes.toString()) {
        if (character === '\r' || character === '\n' || character === '\u0003') {
          process.stdin.setRawMode(false); process.stdin.removeListener('data', onData); process.stdin.pause(); process.stdout.write('\n')
          if (character === '\u0003') reject(systemError('已取消开通。')); else resolve(value)
          return
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1)
        else if (value.length < 4096) value += character
      }
    }
    process.stdin.on('data', onData)
  })
  const first = await ask('浏览器初始密码（输入不回显）：')
  const second = await ask('再次输入：')
  if (first.length < 4 || first !== second) throw systemError('密码至少4字符，且两次输入须相同；未开通用户。')
  return first
}

try {
  const args = parseSystemArguments(process.argv.slice(3)), registry = new SystemRegistry()
  registry.authority()
  const installation = cliLocation.assertSelectedCli(root)
  if (!installation || installation.scope !== 'system') throw systemError('此入口要求已验证的内置system安装；旧部署请使用新版安装器进行兼容转换。')
  verifyRootExecutable(path.join(root, 'scripts/system-user-helper.mjs'))
  const store = new SystemOperationStore(registry)
  if (args.action === 'status') {
    const maintenance = store.maintenance()
    if (maintenance) {
      console.log('作业 ' + maintenance.id + ': ' + maintenance.operation + ' / ' + maintenance.phase)
      if (maintenance.stage) console.log('当前阶段：' + systemOperationStage(maintenance.stage))
    }
    for (const entry of registry.read()) {
      if (!entry.enabled) { console.log(entry.user + '\t已停用（数据保留）'); continue }
      try {
        registry.verifyAccount(entry)
        const status = await runSystemUser(entry, { root, action: 'inspect' })
        let health = ''
        if (status.state === 'running') health = status.ready ? ' / ' + status.health : ' / 未就绪'
        console.log(entry.user + '\t' + status.state + health
          + '\t安装版本 ' + cliLocation.readCoreVersion(root) + ' / 运行版本 ' + (status.core_version ?? '未运行') + '\thttp://localhost:' + (3000 + entry.port_offset))
      } catch (error) { console.log(entry.user + '\t失败：' + error.message); process.exitCode = 1 }
    }
    if (maintenance) {
      const job = store.read(store.file(maintenance.id), true)
      for (const row of job?.progress?.results ?? []) console.log(row.user + '\t' + row.state + (row.message || row.error?.message ? '：' + (row.message ?? row.error.message) : ''))
      if (maintenance.unsettled.length) console.log('结果未知用户UID：' + maintenance.unsettled.join(', ') + '；保留维护保护，未自动重试。')
    }
  } else if (args.action === 'user') {
    store.assertIdle()
    if (systemdAvailable()) installSystemUserService(installation.root)
    else if (args.autostart) throw systemError('当前环境没有systemd，不能配置开机自启动；可不带--autostart开通CLI实例。', 'CRABOT_SYSTEMD_UNAVAILABLE')
    if (args.operation === 'add') {
      const existing = registry.read().find(entry => entry.user === args.user)
      const initial = existing ? null : await password()
      const entry = await registry.register(args.user, { autostart: args.autostart, prepare: async value => {
        store.assertIdle()
        await runSystemUser(value, { root, action: 'prepare', input: { password: initial } })
        if (systemdAvailable()) {
          await ensureSystemUserManager(value)
          await runSystemUser(value, { root, action: 'configure-service' })
        }
      } })
      console.log('已开通 ' + entry.user + '；端口 ' + (3000 + entry.port_offset) + '；开机自启动：' + (entry.autostart ? '开启' : '关闭'))
      console.log('运行方式：' + (systemdAvailable() ? 'systemd按UID托管' : 'CLI（无systemd托管）'))
      console.log('启动：sudo -H -u ' + "'" + entry.user.replaceAll("'", "'\\''") + "'" + ' crabot start -d')
      console.log('服务器本机地址：http://localhost:' + (3000 + entry.port_offset) + '；对外地址请沿已有反向代理配置。')
      console.log('如无对外入口：ssh -L ' + (3000 + entry.port_offset) + ':127.0.0.1:' + (3000 + entry.port_offset) + ' <服务器SSH地址>')
    } else {
      await registry.update(async entries => {
        store.assertIdle()
        const entry = entries.find(value => value.user === args.user)
        if (!entry) throw systemError('用户未开通，未操作其他Linux账号。')
        registry.verifyAccount(entry)
        if (entry.enabled) await runSystemUser(entry, { root, action: 'disable' })
        entry.enabled = false
        return entries
      })
      console.log('已停用 ' + args.user + '，账号与数据保留。')
    }
  } else {
    store.assertIdle()
    if (!systemdAvailable()) throw systemError('持久批量作业要求真实systemd；未停止任何实例。', 'CRABOT_SYSTEMD_UNAVAILABLE')
    const plan = await planSystemBatch(args.action, registry.read(), async entry => {
      registry.verifyAccount(entry); return runSystemUser(entry, { root, action: 'inspect' })
    })
    for (const item of plan.items) console.log(item.entry.user + '\t' + item.observation.state + '\t' + (item.mutate ? args.action : '核对/跳过'))
    const interactive = process.stdin.isTTY === true
    if (requireBatchConfirmation(plan, { yes: args.yes, interactive })) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout })
      let answer
      try { answer = await prompt.question('当前工作可能中断，确认本次维护？[y/N] ') } finally { prompt.close() }
      if (!/^y(es)?$/i.test(answer.trim())) throw systemError('已取消，未执行任何启停。')
    }
    process.exitCode = await submitSystemOperation(plan, { root, store })
  }
} catch (error) { console.error('[crabot] ' + error.message); process.exitCode = 1 }
