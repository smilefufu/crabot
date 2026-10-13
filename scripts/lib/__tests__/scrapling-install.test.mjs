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

function releaseInstallation(t, tool, damaged = false) {
  const root = mkdtempSync(join(tmpdir(), 'crabot-install-checksum-'))
  const version = root.split('/').at(-1)
  const filename = `crabot-${version}-darwin-x64.tar.gz`
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
  writeFileSync(join(root, 'payload/cli.mjs'), '// installation fixture\n')
  const tar = spawnSync('tar', ['-czf', archive, '-C', root, 'payload'], { encoding: 'utf8' })
  assert.equal(tar.status, 0, tar.stderr)
  writeFileSync(checksum, `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${filename}\n`)
  if (damaged) writeFileSync(archive, 'damaged release')
  // Restricted PATH models a clean Mac without sha256sum. Use real checksum tools.
  for (const command of ['mkdir', 'cp', 'tar', 'gzip', 'rm', 'ln', 'chmod', ...(tool ? [tool] : [])]) {
    const resolved = spawnSync('/bin/bash', ['-c', `command -v ${command}`], { encoding: 'utf8' })
    assert.equal(resolved.status, 0, `required test command missing: ${command}`)
    symlinkSync(resolved.stdout.trim(), join(bin, command))
  }
  if (tool === 'sha256sum') {
    writeFileSync(join(bin, 'shasum'), '#!/bin/bash\necho "unexpected shasum fallback" >&2\nexit 99\n', { mode: 0o755 })
  }
  const result = spawnSync('/bin/bash', ['-c', `
    source "$INSTALLER_FILE"
    detect_platform() { echo darwin-x64; }
    ensure_node() { :; }
    ensure_uv() { :; }
    uv() { :; }
    node() { :; }
    curl() {
      case "$2" in
        *.sha256) cp "$FIXTURE_CHECKSUM" "$4" ;;
        *) cp "$FIXTURE_ARCHIVE" "$4" ;;
      esac
    }
    main
  `], {
    encoding: 'utf8',
    env: {
      PATH: bin, HOME: join(root, 'home'), SHELL: '/bin/bash',
      CRABOT_VERSION: version, CRABOT_INSTALL_DIR: installDir,
      INSTALLER_FILE: fileURLToPath(new URL('../../../install.sh', import.meta.url)),
      FIXTURE_ARCHIVE: archive, FIXTURE_CHECKSUM: checksum,
    },
  })
  return { ...result, extracted: existsSync(join(installDir, 'cli.mjs')) }
}
for (const tool of ['shasum', 'sha256sum']) {
  test(`release installation verifies SHA-256 with ${tool}`, { skip: process.platform === 'win32' }, t => {
    const result = releaseInstallation(t, tool)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /tar\.gz: OK/)
    assert.equal(result.extracted, true)
  })
  test(`release installation rejects a damaged archive with ${tool} before extraction`, { skip: process.platform === 'win32' }, t => {
    const result = releaseInstallation(t, tool, true)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout, /Checksum verification failed!/)
    assert.match(result.stdout, /tar\.gz: FAILED/)
    assert.doesNotMatch(result.stdout + result.stderr, /unexpected shasum fallback/)
    assert.equal(result.extracted, false)
  })
}
test('release installation fails before extraction when no checksum tool is available', { skip: process.platform === 'win32' }, t => {
  const result = releaseInstallation(t, null)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /Checksum verification failed!/)
  assert.equal(result.extracted, false)
})
