// Recognition only. The caller's explicit takeover transaction owns locks,
// startup-source fencing, shutdown, backup and any installation/data mutation.
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import { discoverLegacyUserInstall } from './legacy-desktop.mjs'
import { inspectLegacyEntryFence } from './legacy-entry-fence.mjs'
import { withVerifiedLegacyProcessGraph, assertLegacyProcessesCurrent } from './legacy-process-graph.mjs'

const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_LEGACY_RUNTIME_UNVERIFIED' }) }
const samePath = (a, b) => realpathSync(a) === realpathSync(b)

async function verifiedLegacyRuntime(installation, use, { signal, entryFenceId } = {}, fencePhase = 'fenced') {
  let recognized
  if (entryFenceId) {
    const fenced = await inspectLegacyEntryFence(installation.installRoot)
    if (fenced.id !== entryFenceId || fenced.phase !== fencePhase || !fenced.entries_fenced) fail('旧入口尚未完成隔离，未开始接管。')
    recognized = fenced.installation
  } else recognized = await discoverLegacyUserInstall({ root: installation.installRoot, dataDir: installation.dataRoot })
  if (recognized.fingerprint !== installation.fingerprint) fail('旧安装在检查后发生变化，未开始接管。')
  const { installRoot: root, dataRoot: data } = recognized
  let recordedPid = null
  try {
    const file = path.join(data, 'mm.pid'), stat = await fs.lstat(file)
    if (!stat.isFile() || stat.size > 32) fail('旧 PID 记录无法核验，未停止任何进程。')
    const text = (await fs.readFile(file, 'utf8')).trim()
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0) fail('旧 PID 记录无法核验，未停止任何进程。')
    recordedPid = Number(text)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  return withVerifiedLegacyProcessGraph(root, async (snapshot, rpc) => {
    if (snapshot.state === 'stopped') {
      const records = await fs.readdir(path.join(data, 'module-runtime-registry/records')).catch(error => {
        if (error.code === 'ENOENT') return []; throw error
      })
      if (records.some(file => file.endsWith('.json'))) fail('旧模块运行记录尚未收口，不能确认停止。')
      return use({ state: 'stopped', installation: recognized }, null)
    }
    const agent = await rpc.getDefinition('crabot-agent')
    if (typeof agent.env?.DATA_DIR !== 'string' || !samePath(agent.env.DATA_DIR, data)
      || typeof agent.env?.CRABOT_AGENT_DATA_DIR !== 'string'
      || !samePath(agent.env.CRABOT_AGENT_DATA_DIR, path.join(data, 'agent'))
      || typeof agent.cwd !== 'string' || !samePath(agent.cwd, path.join(root, 'crabot-agent'))) {
      fail('旧 MM 的实际数据目录或模块来源不匹配，未发送停机请求。')
    }
    assertLegacyProcessesCurrent(snapshot)
    return use({ ...snapshot, installation: recognized }, rpc)
  }, { signal, recordedPid })
}

export function withVerifiedLegacyRuntime(installation, use, options) {
  return verifiedLegacyRuntime(installation, use, options)
}

// Read-only after the data boundary. No RPC/mutation callback is exposed.
export function discoverSealedLegacyRuntime(installation, options) {
  return verifiedLegacyRuntime(installation, snapshot => snapshot, options, 'data_changing')
}

export async function discoverLegacyRuntime(installation, options) {
  return withVerifiedLegacyRuntime(installation, snapshot => snapshot, options)
}
