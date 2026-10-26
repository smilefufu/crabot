// Development Electron is not a prepared product image. Give only this exact
// CI test executable Ubuntu24's required userns permission; keep its sandbox on.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
assert.equal(process.platform, 'linux')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.GITHUB_REPOSITORY, 'smilefufu/crabot')
assert.ok(process.getuid() > 0)
if ((await fs.readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').catch(() => '')).trim() === '1') {
  const require = createRequire(new URL('../../crabot-desktop/package.json', import.meta.url))
  const executable = await fs.realpath(require('electron')), workspace = await fs.realpath(process.env.GITHUB_WORKSPACE)
  assert.ok(executable.startsWith(path.join(workspace, 'crabot-desktop/node_modules') + path.sep))
  assert.equal(path.basename(executable), 'electron'); assert.ok(!/["\\\r\n\0]/.test(executable))
  assert.ok((await fs.lstat(executable)).isFile())
  const name = 'crabot-ci-electron-' + createHash('sha256').update(executable).digest('hex').slice(0, 24)
  const policy = `abi <abi/4.0>,\nprofile ${name} "${executable}" flags=(unconfined) {\n  userns,\n}\n`
  const result = spawnSync('/usr/bin/sudo', ['-n', '/usr/sbin/apparmor_parser', '--replace'], {
    input: policy, encoding: 'utf8', timeout: 30000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr)
  console.log('CRABOT_CI_DEVELOPMENT_ELECTRON_USERNS exact_executable=true sandbox_disabled=false')
}
