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
  ['scripts/workspace-relocation-coordinator.mjs', true],
  ['scripts/workspace-copy-host.mjs', true],
  ['scripts/workspace-file-host.mjs', true],
  ['scripts/workspace-root-probe.mjs', true],
  ['scripts/workspace-runtime-gate.mjs', true],
  ['.github/scripts/smoke-workspace-python-gate.mjs', true],
  ['scripts/lib/workspace-coordinator-launch.mjs', true],
  ['scripts/lib/known-process-stop.cjs', true],
  ['scripts/lib/process-identity.cjs', true],
  ['crabot-agent/src/core/workspace-relocation-ledgers.ts', true],
  ['crabot-agent/src/engine/host-process.ts', true],
  ['crabot-agent/src/engine/bg-entities/bg-shell.ts', true],
  ['crabot-agent/src/unified-agent.ts', true],
  ['crabot-admin/src/index.ts', true],
  ['crabot-admin/src/workspace-web-admissions.ts', true],
  ['crabot-desktop/native/ubuntu/sandbox-helper.c', true],
  ['crabot-desktop/src/ubuntu-installer-backend.ts', true],
  ['crabot-docs/fixture.md', false],
]) test('actual Git delta classifies runtime scope: ' + file, { timeout: 15000 }, () => {
  const base = git(['rev-parse', 'HEAD'])
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), 'finite scope delta\n'); commit(file)
  execFileSync(process.execPath, [script], { cwd: root, env: { ...env, CRABOT_CI_BASE: base }, stdio: 'pipe' })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.desktop-build/runtime-scope.json'), 'utf8')), { full_runtime: expected })
})
