// CI-only dialog driving and Polkit transport. Production maintenance and the
// native helper retain their authorization, stop, process and file checks.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)
export async function prepareUbuntuUninstallDriver({ repository, resources, control }) {
  assert.equal(process.platform, 'linux'); assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted'); assert.equal(process.env.GITHUB_REPOSITORY, 'smilefufu/crabot')
  assert.equal(await fs.realpath(control), control)
  const { stdout } = await execute('/usr/bin/pkg-config', ['--cflags', '--libs', 'gtk4', 'json-glib-1.0'])
  await execute('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-DCRABOT_MAINTENANCE_ACTOR',
    path.join(repository, 'crabot-desktop/tests/native/ubuntu-maintenance.c'), '-o', path.join(resources, 'crabot-maintenance'), ...stdout.trim().split(/\s+/)], { timeout: 60000 })
  const main = path.join(resources, 'crabot-maintenance-backend/main.mjs'), original = await fs.readFile(main, 'utf8')
  assert.equal(original.split('await runUbuntuRemovalHost(request)').length, 2)
  const fixture = (await fs.readFile(path.join(repository, 'crabot-desktop/tests/fixtures/uninstall-ubuntu-transport.mjs'), 'utf8'))
    .replace('__CRABOT_UNINSTALL_CONTROL__', JSON.stringify(control))
  const driven = original.replace('await runUbuntuRemovalHost(request)',
    "const result = await runUbuntuRemovalHost(request); fixtureEvent(result === 'completed' ? 'completed-dialog' : 'driver-failed', { result })")
    .replace('} catch (error) {', "} catch (error) { fixtureEvent('driver-failed', { code: error?.code, stage: error?.stage });")
  await fs.writeFile(main, fixture + '\n' + driven)
}
