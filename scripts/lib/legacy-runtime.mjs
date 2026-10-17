// Recognition only. The caller's explicit takeover transaction owns locks,
// startup-source fencing, shutdown, backup and any installation/data mutation.
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import identity from './process-identity.cjs'
import { discoverLegacyUserInstall } from './legacy-desktop.mjs'
import { openLegacyMmRpc } from './legacy-mm-rpc.mjs'

const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_LEGACY_RUNTIME_UNVERIFIED' }) }
const samePath = (a, b) => realpathSync(a) === realpathSync(b)

export async function withVerifiedLegacyRuntime(installation, use, { signal } = {}) {
  const recognized = await discoverLegacyUserInstall({ root: installation.installRoot, dataDir: installation.dataRoot })
  if (recognized.fingerprint !== installation.fingerprint) fail('旧安装在检查后发生变化，未开始接管。')
  const { installRoot: root, dataRoot: data } = recognized
  const self = identity.inspectProcess(process.pid), candidates = []
  let recordedPid = null
  try {
    const file = path.join(data, 'mm.pid'), stat = await fs.lstat(file)
    if (!stat.isFile() || stat.size > 32) fail('旧 PID 记录无法核验，未停止任何进程。')
    const text = (await fs.readFile(file, 'utf8')).trim()
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0) fail('旧 PID 记录无法核验，未停止任何进程。')
    recordedPid = Number(text)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const expectedEntries = {
    mm: path.join(root, 'crabot-core/dist/main.js'),
    foreground: path.join(root, 'scripts/start.mjs'),
    daemon: path.join(root, 'scripts/supervisor.mjs'),
  }
  for (const pid of identity.listProcessIds()) {
    let current
    try { current = identity.inspectProcess(pid) }
    catch (error) { if (pid === recordedPid) throw error; continue }
    if (!current || current.owner !== self.owner) continue
    let args
    try { args = identity.inspectProcessArguments(pid) }
    catch {
      if (pid === recordedPid || /^node(?:\.exe)?$/i.test(path.basename(current.executable))) fail('无法核验旧 Node 进程命令行，保留原安装。')
      continue
    }
    if (args.length === 3 && args[2] === 'start') {
      // The published CLI imports start.mjs in the same foreground process.
      // Its actual argv remains node cli.mjs start, rather than the import path.
      try { if (samePath(args[1], path.join(root, 'cli.mjs'))) candidates.push({ kind: 'foreground', process: current }) } catch {}
    }
    if (args.length !== 2) continue
    for (const [kind, entry] of Object.entries(expectedEntries)) {
      try { if (samePath(args[1], entry)) candidates.push({ kind, process: current }) } catch {}
    }
  }
  if (recordedPid && identity.inspectProcess(recordedPid) && !candidates.some(item => item.process.pid === recordedPid && item.kind !== 'mm')) {
    fail('旧 PID 不属于已识别的启动器，未停止任何进程。')
  }
  const controllers = candidates.filter(item => item.kind !== 'mm'), managers = candidates.filter(item => item.kind === 'mm')
  if (!candidates.length) {
    const records = await fs.readdir(path.join(data, 'module-runtime-registry/records')).catch(error => {
      if (error.code === 'ENOENT') return []; throw error
    })
    if (records.some(file => file.endsWith('.json'))) fail('旧模块运行记录尚未收口，不能确认停止。')
    return use({ state: 'stopped', installation: recognized }, null)
  }
  if (controllers.length !== 1 || managers.length !== 1) fail('旧启动来源不明确或仍在变化，保留原安装。')
  const controller = controllers[0], mm = managers[0].process
  if (mm.parent !== controller.process.pid || !samePath(mm.executable, controller.process.executable)) fail('旧 MM 不属于已识别启动器，不能自动接管自定义服务。')
  const ports = identity.listListeningTcpPorts(mm.pid)
  if (ports.length !== 1) fail('无法唯一核验旧 MM 管理通道，保留原安装。')
  const rpc = await openLegacyMmRpc(mm, ports[0], { signal })
  try {
    const agent = await rpc.getDefinition('crabot-agent')
    if (typeof agent.env?.DATA_DIR !== 'string' || !samePath(agent.env.DATA_DIR, data)
      || typeof agent.env?.CRABOT_AGENT_DATA_DIR !== 'string'
      || !samePath(agent.env.CRABOT_AGENT_DATA_DIR, path.join(data, 'agent'))
      || typeof agent.cwd !== 'string' || !samePath(agent.cwd, path.join(root, 'crabot-agent'))) {
      fail('旧 MM 的实际数据目录或模块来源不匹配，未发送停机请求。')
    }
    for (const target of [controller.process, mm]) if (!identity.sameProcess(target, identity.inspectProcess(target.pid))) fail('旧实例在检查期间发生变化，未开始接管。')
    return await use({ state: 'running', installation: recognized, controller: controller.process, mm,
      mm_port: ports[0], launch_kind: controller.kind }, rpc)
  } finally { rpc.close() }
}

export async function discoverLegacyRuntime(installation, options) {
  return withVerifiedLegacyRuntime(installation, snapshot => snapshot, options)
}
