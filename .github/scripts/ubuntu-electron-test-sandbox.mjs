// CI-only exact-executable userns permission for development Electron and the
// relocated monolithic component probe. Prepared products use their real helper.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
export async function prepareCiElectronSandbox(file) {
  assert.equal(process.platform, 'linux')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(process.env.GITHUB_REPOSITORY, 'smilefufu/crabot')
  assert.ok(process.getuid() > 0)
  const executable = await fs.realpath(file), workspace = await fs.realpath(process.env.GITHUB_WORKSPACE)
  const development = executable.startsWith(path.join(workspace, 'crabot-desktop/node_modules') + path.sep) && path.basename(executable) === 'electron'
  const component = path.relative(await fs.realpath(homedir()), executable).split(path.sep)
  assert.ok(development || component.length === 3 && component[0].startsWith('Crabot 打包 ') && component[1] === 'linux-unpacked' && component[2] === 'crabot-desktop')
  assert.ok(!/["\\\r\n\0]/.test(executable))
  assert.ok((await fs.lstat(executable)).isFile())
  if ((await fs.readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').catch(() => '')).trim() !== '1') return
  const name = 'crabot-ci-electron-' + createHash('sha256').update(executable).digest('hex').slice(0, 24)
  const policy = `abi <abi/4.0>,\nprofile ${name} "${executable}" flags=(unconfined) {\n  userns,\n}\n`
  const result = spawnSync('/usr/bin/sudo', ['-n', '/usr/sbin/apparmor_parser', '--replace'], {
    input: policy, encoding: 'utf8', timeout: 30000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr)
  console.log('CRABOT_CI_ELECTRON_USERNS ' + JSON.stringify({ role: development ? 'development' : 'monolithic-component', exact_executable: true, sandbox_disabled: false }))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const require = createRequire(new URL('../../crabot-desktop/package.json', import.meta.url))
  await prepareCiElectronSandbox(require('electron'))
}
