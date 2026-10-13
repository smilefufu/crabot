import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import * as release from '../../upgrade-lib/release.mjs'

const installer = fileURLToPath(new URL('../../../install.sh', import.meta.url))
const unix = { skip: process.platform === 'win32' }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'installer-compat-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function bash(code, env = {}) {
  return spawnSync('/bin/bash', ['-c', 'source "$INSTALLER"\n' + code], {
    encoding: 'utf8', env: { ...process.env, INSTALLER: installer, ...env },
  })
}
test('failed uv download is a failed prerequisite, without an installed message', unix, t => {
  const result = bash('curl() { return 22; }; ensure_uv', { HOME: fixture(t), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' })
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  assert.doesNotMatch(result.stdout, /uv .* installed/)
})
test('release preflight rejects Git Bash and Linux ARM64 before installing prerequisites', unix, () => {
  for (const [os, arch, expected] of [['MINGW64_NT-10.0', 'x86_64', /install\.ps1/], ['Linux', 'aarch64', /Unsupported.*linux-arm64/]]) {
    const result = bash(`uname() { case "$1" in -s) echo '${os}';; -m) echo '${arch}';; esac; };\nensure_node() { echo UNEXPECTED_PREREQUISITE; exit 88; };\nmain`)
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, expected)
    assert.doesNotMatch(result.stdout, /UNEXPECTED_PREREQUISITE/)
  }
})
test('asset selection uses Windows ZIP and rejects unpublished architectures', () => {
  assert.equal(release.detectPlatform('win32', 'x64'), 'windows-x64')
  assert.match(release.getReleaseUrls('v2026.10.12.4', 'windows-x64').url, /windows-x64\.zip$/)
  assert.match(release.getReleaseUrls('v2026.10.12.4', 'darwin-x64').url, /darwin-x64\.tar\.gz$/)
  assert.throws(() => release.detectPlatform('linux', 'arm64'), /unsupported platform/)
})
test('legacy v4 checks Scrapling and rejects mixed or incomplete new Cua packages', async t => {
  const { verifyReleasePackage } = await import('../release-package.mjs')
  const root = fixture(t)
  const files = ['cli.mjs', 'package.json', 'dist/cli/main.js', 'scripts/start.mjs', 'crabot-memory/pyproject.toml', 'crabot-memory/uv.lock', 'scripts/prepare-scrapling.mjs', 'scripts/lib/scrapling-runtime.cjs', 'scripts/scrapling/runtime.json', 'scrapling-runtime.json']
  for (const file of files) { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), file.endsWith('package.json') ? '{}' : '') }
  const calls = []
  await verifyReleasePackage(root, 'v2026.10.12.4', { run: async (...args) => calls.push(args) })
  assert.equal(calls.length, 1)
  assert.ok(calls[0][1][0].endsWith('prepare-scrapling.mjs'))
  mkdirSync(join(root, 'scripts/computer-use'))
  writeFileSync(join(root, 'scripts/computer-use/runtime.json'), '{}')
  await assert.rejects(verifyReleasePackage(root, 'v2026.10.12.4'), /mixed|incomplete|missing/)
  await assert.rejects(verifyReleasePackage(root, 'v2026.10.13'), /missing|incomplete/)
})
test('Bash login and interactive PATH work without hiding an existing profile; repeat is idempotent', unix, t => {
  const home = fixture(t)
  writeFileSync(join(home, '.profile'), 'export PRESERVED_PROFILE=present\n')
  const code = 'configure_path'
  const env = { HOME: home, SHELL: '/bin/bash', FROM_SOURCE: 'false', CRABOT_INSTALL_DIR: join(home, 'product') }
  mkdirSync(join(home, 'product'))
  writeFileSync(join(home, 'product/cli.mjs'), '#!/bin/bash\necho fixture-command\n')
  for (let i = 0; i < 2; i++) {
    const result = bash(code, env)
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
  const base = { ...process.env, HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  const login = spawnSync('/bin/bash', ['--login', '-c', 'test "$PRESERVED_PROFILE" = present && crabot'], { encoding: 'utf8', env: base })
  assert.equal(login.status, 0, login.stderr)
  assert.match(login.stdout, /fixture-command/)
  const interactive = spawnSync('/bin/bash', ['-i', '-c', 'crabot'], { encoding: 'utf8', env: base })
  assert.equal(interactive.status, 0, interactive.stderr)
  assert.equal(readFileSync(join(home, '.profile'), 'utf8').match(/\.local\/bin/g).length, 1)
})

test('CLI repairs dependencies before linking an entry with static third-party imports', async t => {
  const root = fixture(t)
  const fs = await import('node:fs/promises')
  await fs.copyFile(new URL('../../../cli.mjs', import.meta.url), join(root, 'cli.mjs'))
  await fs.mkdir(join(root, 'scripts/lib'), { recursive: true })
  await fs.writeFile(join(root, 'scripts/_preflight.mjs'), `import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';const lib=path.join(path.dirname(fileURLToPath(import.meta.url)),'lib/node_modules/fixture-package');fs.mkdirSync(lib,{recursive:true});fs.writeFileSync(path.join(lib,'package.json'),JSON.stringify({main:'index.js'}));fs.writeFileSync(path.join(lib,'index.js'),'module.exports=true')`)
  await fs.writeFile(join(root, 'scripts/lib/registry.mjs'), "import value from 'fixture-package'; export default value")
  await fs.writeFile(join(root, 'scripts/start.mjs'), "import './_preflight.mjs';import value from './lib/registry.mjs';if(!value)process.exit(1);console.log('entry linked after dependency repair')")
  const result = spawnSync(process.execPath, [join(root, 'cli.mjs'), 'start'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /entry linked after dependency repair/)
})
