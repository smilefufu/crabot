// Read-only operating evidence for a legacy system candidate. No returned field
// authorizes stop/migration; conversion must fence sources and reverify this view.
import fs from 'node:fs'
import path from 'node:path'
import identity from './process-identity.cjs'
import { discoverLegacySystemAccount } from './legacy-system-account.mjs'
import { withVerifiedLegacyProcessGraph, assertLegacyProcessesCurrent } from './legacy-process-graph.mjs'
import { systemError } from './system-registry.mjs'
const fail = () => { throw systemError('旧运行实例的实际目录、端口或来源不一致，未转换。', 'CRABOT_LEGACY_SYSTEM_RUNTIME') }
export async function discoverLegacySystemDeployment(context, { observeAccount = discoverLegacySystemAccount, observeProcesses = withVerifiedLegacyProcessGraph } = {}) {
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
    const checked = await observeAccount(context)
    if (checked.manifest_fingerprint !== account.manifest_fingerprint || checked.code_fingerprint !== account.code_fingerprint) fail()
    if (snapshot.state !== 'running') return { ...account, runtime_state: 'no_known_launcher' }
    assertLegacyProcessesCurrent(snapshot)
    return { ...account, runtime_state: 'running', data_binding: 'observed_running', data_dir: dataDir,
      controller: snapshot.controller, mm: snapshot.mm, mm_port: snapshot.mm_port, launch_kind: snapshot.launch_kind }
  })
}
