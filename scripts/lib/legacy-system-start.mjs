// Pre-data legacy restoration only. Root's existing conversion stage authorizes
// the original running set; this code executes only after the employee UID drop.
import fs from 'node:fs'
import path from 'node:path'
import { userInfo } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { validateSystemConversionInstance } from './system-conversion.mjs'
import { systemError } from './system-registry.mjs'
import { systemUserEnvironment } from './system-user.mjs'
import { discoverLegacySystemAccount } from './legacy-system-account.mjs'
import { discoverLegacySystemDeployment, withObservedLegacySystemBinding } from './legacy-system-runtime.mjs'
import { assertLegacySystemDataLayout, inspectLegacySystemDataDirectory } from './legacy-system-directory.mjs'
import { readVersionMaintenance } from './version-maintenance.mjs'
import { probeSystemReadiness } from './system-control.mjs'
import identity from './process-identity.cjs'
const execute = promisify(execFile)
const fail = () => { throw systemError('旧实例尚未证明安全恢复或健康，未改用新Node、重放启动或终止未知进程；请检查本人状态。', 'CRABOT_LEGACY_SYSTEM_START_UNKNOWN') }

// runtimeOptions/run/readiness are controlled fixture seams, never permit/env
// options. The root coordinator must independently prove restored source entries.
export async function startRestoredLegacySystemInstance(entry, context, { expected, operationId,
  runtimeOptions, run = execute, readiness = probeSystemReadiness, waitMs = 90_000 } = {}) {
  const actual = userInfo()
  if (entry?.uid <= 0 || actual.uid !== entry?.uid || actual.gid !== entry.gid || actual.username !== entry.user || actual.homedir !== entry.home) fail()
  validateSystemConversionInstance({ entry, observation: expected }, context.release)
  if (expected.runtime_state !== 'running' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(operationId ?? '')
    || !Number.isFinite(waitMs) || waitMs <= 0 || waitMs > 90_000) fail()
  const options = { observeAccount: discoverLegacySystemAccount, ...runtimeOptions }
  if ((await withObservedLegacySystemBinding(context, expected, value => value, options)).state !== 'stopped') fail()
  assertLegacySystemDataLayout(entry.data_dir)
  if (readVersionMaintenance(entry.data_dir)) fail()
  const node = expected.controller.executable, stat = fs.lstatSync(node)
  if (!stat.isFile() || fs.realpathSync(node) !== node || !(stat.mode & 0o111)) fail()
  const environment = systemUserEnvironment(entry)
  const args = ['--user', '--quiet', '--collect', '--no-ask-password', '--expand-environment=no',
    '--unit=crabot-legacy-restore-' + operationId, '--property=Type=forking', '--property=PIDFile=' + path.join(entry.data_dir, 'mm.pid'),
    '--property=WorkingDirectory=/', '--property=Restart=no', '--property=KillMode=mixed', '--property=SendSIGKILL=no',
    '--property=TimeoutStartSec=90', '--property=TimeoutStopSec=90',
    ...Object.entries(environment).map(([key, value]) => '--setenv=' + key + '=' + value), '--setenv=NODE_OPTIONS=', '--setenv=NODE_PATH=',
    '--', node, path.join(context.release.installRoot, 'scripts/start.mjs'), '-d']
  try { await run('/usr/bin/systemd-run', args, { env: environment, cwd: '/', encoding: 'utf8', timeout: 120_000, maxBuffer: 65536 }) }
  catch { fail() }
  const deadline = Date.now() + waitMs
  do {
    const current = await discoverLegacySystemDeployment(context, options)
    if (current.runtime_state === 'running') {
      inspectLegacySystemDataDirectory(entry.data_dir, expected.data_directory)
      if (current.data_dir !== entry.data_dir || current.controller.executable !== node || current.mm.executable !== node
        || identity.sameProcess(expected.controller, current.controller) || identity.sameProcess(expected.mm, current.mm)
        || readVersionMaintenance(entry.data_dir)) fail()
      const health = await readiness(19000 + entry.port_offset)
      const checked = await discoverLegacySystemDeployment(context, options)
      if (!identity.sameProcess(current.controller, checked.controller) || !identity.sameProcess(current.mm, checked.mm)) fail()
      inspectLegacySystemDataDirectory(entry.data_dir, expected.data_directory)
      if (readVersionMaintenance(entry.data_dir)) fail()
      if (health.ready === true && ['healthy', 'degraded'].includes(health.health)) return { state: 'started' }
    }
    if (Date.now() >= deadline) break
    await new Promise(resolve => setTimeout(resolve, 250))
  } while (true)
  fail()
}
