// Neutral same-UID process observation. Callers must separately verify the old
// code, deployment policy and data binding before authorizing any mutation.
import { realpathSync, readlinkSync } from 'node:fs'
import path from 'node:path'
import identity from './process-identity.cjs'
import { openLegacyMmRpc } from './legacy-mm-rpc.mjs'
const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_LEGACY_RUNTIME_UNVERIFIED' }) }
const samePath = (a, b) => realpathSync(a) === realpathSync(b)
export function assertLegacyProcessesCurrent(snapshot) {
  for (const target of [snapshot.controller, snapshot.mm]) if (!identity.sameProcess(target, identity.inspectProcess(target.pid))) fail('旧实例在检查期间发生变化，未开始接管。')
}
function processEntry(current, args) {
  if (typeof args[1] !== 'string' || args[1].startsWith('-')) return
  let file = args[1]
  if (!path.isAbsolute(file) && process.platform === 'linux') {
    let cwd
    try { cwd = readlinkSync('/proc/' + current.pid + '/cwd') }
    catch {
      if (!identity.inspectProcess(current.pid)) return
      fail('无法核验旧进程实际工作目录，保留原安装。')
    }
    if (!identity.sameProcess(current, identity.inspectProcess(current.pid))) fail('旧进程在工作目录检查期间变化，保留原安装。')
    file = path.resolve(cwd, file)
  }
  try { return realpathSync(file) } catch {}
}
export async function withVerifiedLegacyProcessGraph(root, use, { signal, recordedPid = null } = {}) {
  const self = identity.inspectProcess(process.pid), candidates = []
  const expectedEntries = { mm: path.join(root, 'crabot-core/dist/main.js'), foreground: path.join(root, 'scripts/start.mjs'), daemon: path.join(root, 'scripts/supervisor.mjs') }
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
    const entry = processEntry(current, args)
    if (entry === path.join(root, 'cli.mjs')) {
      if (args.length !== 3 || args[2] !== 'start') fail('旧管理命令仍在运行，请等待结束后重新检查。')
      candidates.push({ kind: 'foreground', process: current }); continue
    }
    if (entry && path.dirname(entry) === path.join(root, 'scripts') && !['start.mjs', 'supervisor.mjs'].includes(path.basename(entry))) fail('旧管理脚本仍在运行，请等待结束后重新检查。')
    if (args.length !== 2) continue
    for (const [kind, expected] of Object.entries(expectedEntries)) if (entry === expected) candidates.push({ kind, process: current })
  }
  if (recordedPid && identity.inspectProcess(recordedPid) && !candidates.some(item => item.process.pid === recordedPid && item.kind !== 'mm')) fail('旧 PID 不属于已识别的启动器，未停止任何进程。')
  if (!candidates.length) return use({ state: 'stopped' }, null)
  const controllers = candidates.filter(item => item.kind !== 'mm'), managers = candidates.filter(item => item.kind === 'mm')
  if (controllers.length !== 1 || managers.length !== 1) fail('旧启动来源不明确或仍在变化，保留原安装。')
  const controller = controllers[0], mm = managers[0].process
  if (mm.parent !== controller.process.pid || !samePath(mm.executable, controller.process.executable)) fail('旧 MM 不属于已识别启动器，不能自动接管自定义服务。')
  const ports = identity.listListeningTcpPorts(mm.pid)
  if (ports.length !== 1) fail('无法唯一核验旧 MM 管理通道，保留原安装。')
  const snapshot = { state: 'running', controller: controller.process, mm, mm_port: ports[0], launch_kind: controller.kind }
  assertLegacyProcessesCurrent(snapshot)
  const rpc = await openLegacyMmRpc(mm, ports[0], { signal })
  try { return await use(snapshot, rpc) } finally { rpc.close() }
}
