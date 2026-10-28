// CI transport only. The unchanged native helper verifies and registers the
// exact prepared GUI/browser roles; this never substitutes its result or policy.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export async function registerUbuntuFixturePrograms(prepared) {
  if (process.platform !== 'linux') return
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.ok(process.getuid() > 0)
  const restricted = (await fs.readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').catch(() => '')).trim() === '1'
  if (!restricted) return
  const helper = path.join(prepared.guiRoot, 'resources/crabot-sandbox-helper')
  await promisify(execFile)('/usr/bin/sudo', ['-n', '/usr/bin/env', 'PKEXEC_UID=' + process.getuid(), helper, '--register', prepared.installRoot],
    { timeout: 60000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })
  console.log('CRABOT_CI_SANDBOX_REGISTERED ' + JSON.stringify({ actual_native_helper: true, polkit_transport_substituted: true }))
}
