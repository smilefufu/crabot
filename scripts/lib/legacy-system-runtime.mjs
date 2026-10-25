// Read-only operating evidence for a legacy system candidate. No returned field
// authorizes stop/migration; conversion must fence sources and reverify this view.
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { inspectLegacySystemDataDirectory, assertLegacySystemDataLayout } from './legacy-system-directory.mjs'
import { inspectInstance } from './instance-runtime.mjs'
import { discoverFencedLegacySystemRelease } from './legacy-system-release.mjs'
import path from 'node:path'
import identity from './process-identity.cjs'
import { discoverLegacySystemAccount, readLegacySystemManifest } from './legacy-system-account.mjs'
import { withVerifiedLegacyProcessGraph, assertLegacyProcessesCurrent } from './legacy-process-graph.mjs'
import { systemError } from './system-registry.mjs'
const fail = () => { throw systemError('旧运行实例的实际目录、端口或来源不一致，未转换。', 'CRABOT_LEGACY_SYSTEM_RUNTIME') }
function assertStoppedData(dataDir) {
  if (inspectInstance(dataDir).state !== 'stopped') fail()
  let records
  try { records = fs.readdirSync(path.join(dataDir, 'module-runtime-registry/records')) }
  catch (error) { if (error.code !== 'ENOENT') throw error; records = [] }
  if (records.some(file => file.endsWith('.json'))) fail()
}
async function verifiedSystemRuntime(context, use, { observeAccount = discoverLegacySystemAccount, observeProcesses = withVerifiedLegacyProcessGraph,
  readManifest = readLegacySystemManifest, signal } = {}, standardStopped = false) {
  const account = await observeAccount(context)
  return observeProcesses(context.release.installRoot, async (snapshot, rpc) => {
    let dataDir
    if (snapshot.state === 'running') {
      if (snapshot.mm_port !== 19000 + context.port_offset_hint) fail()
      const agent = await rpc.getDefinition('crabot-agent')
      try {
        if (typeof agent.env?.DATA_DIR !== 'string' || !path.isAbsolute(agent.env.DATA_DIR) || /[\0\r\n]/.test(agent.env.DATA_DIR)) fail()
        dataDir = fs.realpathSync(agent.env.DATA_DIR)
        if (dataDir === '/' || !identity.isOwnedDirectory(dataDir) || typeof agent.env.CRABOT_AGENT_DATA_DIR !== 'string'
          || fs.realpathSync(agent.env.CRABOT_AGENT_DATA_DIR) !== path.join(dataDir, 'agent') || typeof agent.cwd !== 'string'
          || fs.realpathSync(agent.cwd) !== path.join(context.release.installRoot, 'crabot-agent')
          || agent.env.CRABOT_PORT_OFFSET !== undefined && agent.env.CRABOT_PORT_OFFSET !== String(context.port_offset_hint)) fail()
      } catch { fail() }
    }
    if (snapshot.state === 'stopped' && standardStopped && context.account) {
      const { account: owner, port_offset_hint: offset, release } = context
      if (owner.uid !== account.uid || owner.user !== account.user || account.port_offset !== offset || account.install_root !== release.installRoot) fail()
      const { bytes, value } = readManifest(owner)
      dataDir = path.join(owner.home, '.crabot', 'data-' + offset)
      if (createHash('sha256').update(bytes).digest('hex') !== account.manifest_fingerprint || value?.mode !== 'system' || value.port_offset !== offset
        || typeof value.crabot_home !== 'string' || !path.isAbsolute(value.crabot_home) || fs.realpathSync(value.crabot_home) !== release.installRoot
        || value.data_dir !== undefined && value.data_dir !== dataDir) fail()
      inspectLegacySystemDataDirectory(dataDir)
      assertLegacySystemDataLayout(dataDir)
      assertStoppedData(dataDir)
    }
    const checked = await observeAccount(context)
    if (checked.manifest_fingerprint !== account.manifest_fingerprint || checked.code_fingerprint !== account.code_fingerprint) fail()
    if (snapshot.state !== 'running') {
      if (dataDir) {
        const directory = inspectLegacySystemDataDirectory(dataDir)
        assertStoppedData(dataDir)
        return use({ ...account, runtime_state: 'stopped', data_binding: 'verified_stopped', data_dir: dataDir, data_directory: directory.identity }, null)
      }
      return use({ ...account, runtime_state: 'no_known_launcher' }, null)
    }
    assertLegacyProcessesCurrent(snapshot)
    return use({ ...account, runtime_state: 'running', data_binding: 'observed_running', data_dir: dataDir,
      data_directory: inspectLegacySystemDataDirectory(dataDir).identity,
      controller: snapshot.controller, mm: snapshot.mm, mm_port: snapshot.mm_port, launch_kind: snapshot.launch_kind }, rpc)
  }, { signal })
}

export function discoverLegacySystemDeployment(context, options) {
  return verifiedSystemRuntime(context, snapshot => snapshot, options, true)
}

// Read-only prior-binding verification. Code policy belongs to the scene caller;
// this grants no lifecycle authority and does not derive a new stopped data path.
export async function withObservedLegacySystemBinding(context, expected, use, { observeAccount = discoverLegacySystemAccount,
  observeProcesses = withVerifiedLegacyProcessGraph, signal } = {}) {
  if (!['running', 'stopped'].includes(expected?.runtime_state) || expected.data_binding !== (expected.runtime_state === 'running' ? 'observed_running' : 'verified_stopped')
    || !expected.data_directory || typeof expected.data_dir !== 'string' || !path.isAbsolute(expected.data_dir)) fail()
  return verifiedSystemRuntime(context, async (snapshot, rpc) => {
    for (const key of ['uid', 'user', 'port_offset', 'install_root', 'code_fingerprint', 'manifest_fingerprint']) {
      if (snapshot[key] !== expected[key]) fail()
    }
    const dataDir = inspectLegacySystemDataDirectory(expected.data_dir, expected.data_directory).directory
    if (dataDir !== expected.data_dir) fail()
    if (snapshot.runtime_state === 'running') {
      if (expected.runtime_state !== 'running' || snapshot.data_dir !== dataDir || snapshot.mm_port !== expected.mm_port
        || !identity.sameProcess(expected.controller, snapshot.controller) || !identity.sameProcess(expected.mm, snapshot.mm)) fail()
      return use({ ...snapshot, state: 'running' }, rpc)
    }
    assertStoppedData(dataDir)
    return use({ ...snapshot, state: 'stopped', data_dir: dataDir }, null)
  }, { observeAccount, observeProcesses, signal })
}

// A conversion adapter, not root authority. The caller's dedicated root job must
// own the fence/permit. All observations and the shutdown RPC remain in this UID.
export function withFencedLegacySystemRuntime(context, expected, use, options = {}) {
  return withObservedLegacySystemBinding(context, expected, use, { observeAccount: account =>
    discoverLegacySystemAccount(account, { discoverRelease: discoverFencedLegacySystemRelease }), ...options })
}
