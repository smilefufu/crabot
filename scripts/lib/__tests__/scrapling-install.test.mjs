import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
const source = readFileSync(new URL('../../../install.sh', import.meta.url), 'utf8').split('# --- OS 检测 ---')[0]
function directory(args, env = {}) {
  const result = spawnSync('bash', ['-c', 'id() { echo 0; };\n' + source + '\nprintf "%s" "$INSTALL_DIR"', 'install', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/fixture/root', ...env },
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
test('installation default and explicit path precedence', () => {
  assert.equal(directory(['--system']), '/opt/crabot')
  assert.equal(directory([]), '/fixture/root/.crabot')
  assert.equal(directory(['--system'], { CRABOT_INSTALL_DIR: '/fixture/env' }), '/fixture/env')
  assert.equal(directory(['--system', '--install-dir=/fixture/explicit'], { CRABOT_INSTALL_DIR: '/fixture/env' }), '/fixture/explicit')
})

function releaseInstallation(t, tool, damaged = false, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'crabot-install-checksum-'))
  const version = root.split('/').at(-1)
  const platform = `${process.platform}-${process.arch}`
  const filename = `crabot-${version}-${platform}.tar.gz`
  const archive = join(root, 'release.tar.gz')
  const checksum = join(root, 'release.sha256')
  const bin = join(root, 'bin')
  const installDir = join(root, 'installed')
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    for (const suffix of ['', '.sha256']) rmSync(`/tmp/${filename}${suffix}`, { force: true })
  })
  mkdirSync(join(root, 'payload/crabot-memory'), { recursive: true })
  mkdirSync(join(root, 'home'))
  mkdirSync(bin)
  for (const file of ['cli.mjs', 'package.json', 'dist/cli/main.js', 'scripts/start.mjs', 'crabot-memory/pyproject.toml', 'crabot-memory/uv.lock']) {
    mkdirSync(join(root, 'payload', file, '..'), { recursive: true })
    writeFileSync(join(root, 'payload', file), '')
  }
  writeFileSync(join(root, 'payload/scripts/check-release.mjs'), `process.exit(${options.checkFailure ? 9 : 0})\n`)
  if (options.existing) {
    mkdirSync(join(installDir, 'data'), { recursive: true })
    writeFileSync(join(installDir, 'cli.mjs'), 'old-code')
    writeFileSync(join(installDir, 'VERSION'), 'old-version')
    writeFileSync(join(installDir, 'data/sentinel'), 'user-data')
  }
  const tar = spawnSync('tar', ['-czf', archive, '-C', root, 'payload'], { encoding: 'utf8' })
  assert.equal(tar.status, 0, tar.stderr)
  writeFileSync(checksum, `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${filename}\n`)
  if (damaged) writeFileSync(archive, 'damaged release')
  // Restricted PATH models a clean Mac without sha256sum. Use real checksum tools.
  for (const command of ['mkdir', 'cp', 'tar', 'gzip', 'rm', 'ln', 'chmod', 'mv', 'mktemp', ...(tool ? [tool] : [])]) {
    const resolved = spawnSync('/bin/bash', ['-c', `command -v ${command}`], { encoding: 'utf8' })
    assert.equal(resolved.status, 0, `required test command missing: ${command}`)
    symlinkSync(resolved.stdout.trim(), join(bin, command))
  }
  if (tool === 'sha256sum') {
    writeFileSync(join(bin, 'shasum'), '#!/bin/bash\necho "unexpected shasum fallback" >&2\nexit 99\n', { mode: 0o755 })
  }
  const result = spawnSync('/bin/bash', ['-c', `
    source "$INSTALLER_FILE"
    detect_platform() { echo "$FIXTURE_PLATFORM"; }
    getconf() { echo "glibc 2.35"; }
    ensure_node() { :; }
    ensure_uv() { :; }
    uv() { return "$FIXTURE_UV_STATUS"; }
    node() { "$REAL_NODE" "$@"; }
    curl() {
      case "$2" in
        *.sha256) if [ "$FIXTURE_CHECKSUM_STATUS" != 0 ]; then return "$FIXTURE_CHECKSUM_STATUS"; fi; cp "$FIXTURE_CHECKSUM" "$4" ;;
        *) cp "$FIXTURE_ARCHIVE" "$4" ;;
      esac
    }
    main
  `], {
    encoding: 'utf8',
    env: {
      FIXTURE_UV_STATUS: options.memoryFailure ? "19" : "0", FIXTURE_CHECKSUM_STATUS: options.missingChecksum ? "22" : "0",
      REAL_NODE: process.execPath, FIXTURE_PLATFORM: platform, PATH: bin, HOME: join(root, 'home'), SHELL: '/bin/bash',
      CRABOT_VERSION: version, CRABOT_INSTALL_DIR: installDir,
      INSTALLER_FILE: fileURLToPath(new URL('../../../install.sh', import.meta.url)),
      FIXTURE_ARCHIVE: archive, FIXTURE_CHECKSUM: checksum,
    },
  })
  return { ...result, extracted: existsSync(join(installDir, 'cli.mjs')), cli: existsSync(join(installDir, 'cli.mjs')) ? readFileSync(join(installDir, 'cli.mjs'), 'utf8') : null, version: existsSync(join(installDir, 'VERSION')) ? readFileSync(join(installDir, 'VERSION'), 'utf8').trim() : null, data: existsSync(join(installDir, 'data/sentinel')) ? readFileSync(join(installDir, 'data/sentinel'), 'utf8') : null }
}
for (const tool of ['shasum', 'sha256sum']) {
  const unavailable = process.platform === 'win32' || spawnSync('/bin/bash', ['-c', `command -v ${tool}`]).status !== 0
  test(`release installation verifies SHA-256 with ${tool}`, { skip: unavailable }, t => {
    const result = releaseInstallation(t, tool)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /tar\.gz: OK/)
    assert.equal(result.extracted, true)
  })
  test(`release installation rejects a damaged archive with ${tool} before extraction`, { skip: unavailable }, t => {
    const result = releaseInstallation(t, tool, true)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout + result.stderr, /Checksum verification failed!/)
    assert.match(result.stdout, /tar\.gz: FAILED/)
    assert.doesNotMatch(result.stdout + result.stderr, /unexpected shasum fallback/)
    assert.equal(result.extracted, false)
  })
}
test('release installation fails before extraction when no checksum tool is available', { skip: process.platform === 'win32' }, t => {
  const result = releaseInstallation(t, null)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout + result.stderr, /Checksum verification failed!/)
  assert.equal(result.extracted, false)
})

for (const options of [{ missingChecksum: true }, { checkFailure: true }]) {
  test(`failed release preparation preserves old code/version/data: ${JSON.stringify(options)}`, { skip: process.platform === 'win32' }, t => {
    const result = releaseInstallation(t, 'shasum', false, { existing: true, ...options })
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    assert.equal(result.cli, 'old-code')
    assert.equal(result.version, 'old-version')
    assert.equal(result.data, 'user-data')
    assert.doesNotMatch(result.stdout, /Done!/)
  })
}
test('post-replacement Memory sync failure preserves data and does not claim the new version', { skip: process.platform === 'win32' }, t => {
  const result = releaseInstallation(t, 'shasum', false, { existing: true, memoryFailure: true })
  assert.notEqual(result.status, 0)
  assert.equal(result.version, 'old-version')
  assert.equal(result.data, 'user-data')
  assert.doesNotMatch(result.stdout, /Done!/)
})
