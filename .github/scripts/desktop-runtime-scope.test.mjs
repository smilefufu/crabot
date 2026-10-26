import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./desktop-runtime-scope.mjs', import.meta.url))
let root, env
function git(args) { return execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function commit(file) {
  git(['add', '--', file])
  git(['-c', 'user.name=Scope Fixture', '-c', 'user.email=scope@example.invalid', 'commit', '-qm', 'finite scope fixture'])
}
before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'desktop-runtime-scope-')))
  const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL'])
  env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())))
  const config = path.join(root, 'empty-config'); fs.writeFileSync(config, '')
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0', GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: '' })
  git(['init', '-q'])
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'finite fixture\n'); commit('fixture.txt')
})
after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }) })

for (const [file, expected] of [
  ['.github/workflows/desktop-ubuntu-bootstrap.yml', true],
  ['crabot-desktop/tests/ubuntu-removal-progress.test.mjs', true],
  ['crabot-desktop/tests/ubuntu-removal-host.test.mjs', true],
  ['.github/scripts/test-linux-resource-download.mjs', true],
  ['crabot-desktop/src/bootstrap-log.ts', true],
  ['crabot-desktop/tests/fixtures/ubuntu-removal-node-parent.cjs', true],
  ['crabot-desktop/tests/fixtures/removal-progress-peer.c', true],
  ['scripts/workspace-relocation-coordinator.mjs', true],
  ['scripts/workspace-copy-host.mjs', true],
  ['scripts/workspace-file-host.mjs', true],
  ['scripts/workspace-root-probe.mjs', true],
  ['scripts/workspace-runtime-gate.mjs', true],
  ['.github/scripts/smoke-workspace-python-gate.mjs', true],
  ['scripts/lib/workspace-coordinator-launch.mjs', true],
  ['scripts/lib/known-process-stop.cjs', true],
  ['scripts/lib/known-process-exit.cjs', true],
  ['crabot-native/src/program-references.h', true],
  ['scripts/lib/__tests__/program-references.test.mjs', true],
  ['scripts/lib/__tests__/fixtures/program-reference-build.mjs', true],
  ['scripts/lib/__tests__/fixtures/program-reference-holder.cc', true],
  ['scripts/lib/desktop-preparation-files.mjs', true],
  ['scripts/lib/desktop-cli-text.mjs', true],
  ['crabot-desktop/tests/cli-removal.test.mjs', true],
  ['crabot-desktop/src/login-startup.ts', true],
  ['crabot-desktop/tests/release-intake-electron.test.mjs', true],
  ['crabot-desktop/tests/release-intake-electron.cjs', true],
  ['scripts/lib/desktop-repair.mjs', true],
  ['scripts/lib/desktop-program-proof.mjs', true],
  ['scripts/lib/desktop-removal-proof.mjs', true],
  ['scripts/lib/desktop-removal-programs.mjs', true],
  ['scripts/lib/desktop-removal-context.mjs', true],
  ['scripts/lib/desktop-removal-delete.mjs', true],
  ['scripts/lib/desktop-removal-system-processes.mjs', true],
  ['scripts/lib/__tests__/desktop-removal-system-processes.test.mjs', true],
  ['scripts/lib/desktop-reinstall.mjs', true],
  ['scripts/lib/desktop-reinstall-data.mjs', true],
  ['scripts/lib/data-compatibility.mjs', true],
  ['scripts/lib/module-data-versions.mjs', true],
  ['scripts/lib/desktop-removal-source.mjs', true],
  ['scripts/lib/__tests__/desktop-removal-programs.test.mjs', true],
  ['.github/scripts/paired-update-source-data.test.mjs', true],
  ['.github/scripts/paired-update-target-evidence.mjs', true],
  ['.github/scripts/paired-update-target-evidence.test.mjs', true],
  ['.github/scripts/paired-update-source-model.test.mjs', true],
  ['crabot-desktop/tests/fixtures/paired-update-model-provider.mjs', true],
  ['crabot-desktop/tests/fixtures/paired-update-source-model.cjs', true],
  ['.github/scripts/paired-update-source-activity.test.mjs', true],
  ['crabot-desktop/tests/fixtures/paired-update-source-activity.cjs', true],
  ['crabot-desktop/tests/fixtures/paired-update-source-data.cjs', true],
  ['crabot-desktop/tests/fixtures/paired-update-limits.cjs', true],
  ['.github/scripts/check-paired-update-report.mjs', true],
  ['.github/scripts/check-paired-update-report.test.mjs', true],
  ['scripts/lib/desktop-removal-host.mjs', true],
  ['scripts/lib/desktop-removal-frame.mjs', true],
  ['scripts/lib/desktop-removal-job.mjs', true],
  ['crabot-desktop/tests/removal-frame.test.mjs', true],
  ['crabot-desktop/tests/fixtures/removal-frame-actor.cjs', true],
  ['scripts/lib/desktop-maintenance-bootstrap.mjs', true],
  ['crabot-desktop/build-preload.mjs', true],
  ['crabot-desktop/src/removal-preload.ts', true],
  ['crabot-desktop/src/operation-progress-window.ts', true],
  ['crabot-desktop/tests/maintenance-bootstrap.test.mjs', true],
  ['crabot-desktop/tests/maintenance-bootstrap-probe.cjs', true],
  ['scripts/lib/module-process-start.cjs', true],
  ['scripts/lib/instance-controller.mjs', true],
  ['scripts/lib/desktop-removal-record.cjs', true],
  ['scripts/lib/process-identity.cjs', true],
  ['crabot-agent/src/core/workspace-relocation-ledgers.ts', true],
  ['crabot-agent/src/engine/host-process.ts', true],
  ['crabot-agent/src/engine/bg-entities/bg-shell.ts', true],
  ['crabot-agent/src/unified-agent.ts', true],
  ['crabot-admin/src/index.ts', true],
  ['crabot-admin/src/workspace-web-admissions.ts', true],
  ['crabot-desktop/native/ubuntu/sandbox-helper.c', true],
  ['crabot-desktop/src/ubuntu-installer-backend.ts', true],
  ['crabot-desktop/src/ubuntu-program-probe.ts', true],
  ['crabot-desktop/src/paired-update.ts', true],
  ['.github/scripts/accept-ubuntu-offline-installer.mjs', true],
  ['.github/scripts/prepare-paired-update-core.mjs', true],
  ['crabot-client/src/contracts/desktop-release.ts', true],
  ['crabot-desktop/src/release-signatures.ts', true],
  ['.github/scripts/test-paired-release-intake.mjs', true],
  ['.github/scripts/verify-complete-paired-release.mjs', true],
  ['crabot-docs/fixture.md', false],
]) test('actual Git delta classifies runtime scope: ' + file, { timeout: 15000 }, () => {
  const base = git(['rev-parse', 'HEAD'])
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), 'finite scope delta\n'); commit(file)
  execFileSync(process.execPath, [script], { cwd: root, env: { ...env, CRABOT_CI_BASE: base }, stdio: 'pipe' })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.desktop-build/runtime-scope.json'), 'utf8')), { full_runtime: expected })
})
