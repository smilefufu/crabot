import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, chmodSync, symlinkSync, readlinkSync, existsSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readdirSync } from 'node:fs'
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
  await fs.copyFile(new URL('../cli-location.cjs', import.meta.url), join(root, 'scripts/lib/cli-location.cjs'))
  await fs.writeFile(join(root, 'scripts/_preflight.mjs'), `import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';const lib=path.join(path.dirname(fileURLToPath(import.meta.url)),'lib/node_modules/fixture-package');fs.mkdirSync(lib,{recursive:true});fs.writeFileSync(path.join(lib,'package.json'),JSON.stringify({main:'index.js'}));fs.writeFileSync(path.join(lib,'index.js'),'module.exports=true')`)
  await fs.writeFile(join(root, 'scripts/lib/registry.mjs'), "import value from 'fixture-package'; export default value")
  await fs.writeFile(join(root, 'scripts/start.mjs'), "import './_preflight.mjs';import value from './lib/registry.mjs';if(!value)process.exit(1);console.log('entry linked after dependency repair')")
  const result = spawnSync(process.execPath, [join(root, 'cli.mjs'), 'start'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /entry linked after dependency repair/)
})

test('fresh nvm installation remains usable in new Bash login and interactive shells', unix, t => {
  const home = fixture(t)
  mkdirSync(join(home, '.nvm'))
  mkdirSync(join(home, 'node-bin'))
  mkdirSync(join(home, 'product'))
  writeFileSync(join(home, '.nvm/nvm.sh'), 'export PATH="$HOME/node-bin:$PATH"\n')
  writeFileSync(join(home, 'node-bin/node'), '#!/bin/bash\necho nvm-node-found\n', { mode: 0o755 })
  writeFileSync(join(home, 'product/cli.mjs'), '#!/bin/bash\nnode\n', { mode: 0o755 })
  const result = bash('NODE_SWITCHED_BY_NVM=true; configure_path', { HOME: home, SHELL: '/bin/bash', NVM_DIR: join(home, '.nvm'), CRABOT_INSTALL_DIR: join(home, 'product') })
  assert.equal(result.status, 0, result.stderr)
  for (const args of [['--login', '-c'], ['-i', '-c']]) {
    const env = { ...process.env, HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
    delete env.NVM_DIR
    const shell = spawnSync('/bin/bash', [...args, 'crabot'], { encoding: 'utf8', env })
    assert.equal(shell.status, 0, shell.stderr)
    assert.match(shell.stdout, /nvm-node-found/)
  }
})

test('cancelled streaming upgrade download removes only its owned staging', unix, async t => {
  const root = fixture(t)
  let started
  const requested = new Promise(resolve => { started = resolve })
  const server = createServer((req, res) => { res.write('partial-archive'); started() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const script = join(root, 'download.mjs')
  const url = `http://127.0.0.1:${server.address().port}/release.tar.gz`
  writeFileSync(script, `import {downloadRelease} from ${JSON.stringify(new URL('../../upgrade-lib/release.mjs', import.meta.url).href)};try{await downloadRelease({url:${JSON.stringify(url)},sha256Url:${JSON.stringify(url + '.sha256')},version:'fixture',logger:console})}catch{process.exitCode=1}`)
  writeFileSync(join(root, 'sentinel'), 'existing-user-state')
  const parent = spawn(process.execPath, [script], { env: { ...process.env, TMPDIR: root, TEMP: root, TMP: root }, stdio: 'ignore' })
  const exited = once(parent, 'exit')
  try {
    await requested
    parent.kill('SIGTERM')
    const [code] = await exited
    assert.notEqual(code, 0)
    assert.deepEqual(readdirSync(root).filter(name => name.startsWith('crabot-upgrade-')), [])
    assert.equal(readFileSync(join(root, 'sentinel'), 'utf8'), 'existing-user-state')
  } finally {
    parent.kill('SIGKILL')
    server.closeAllConnections()
    server.close()
  }
})

test('uv bootstrap retries only a transport failure and rejects a bad checksum before extraction', unix, t => {
  for (const mode of ['transport', 'hash', 'io']) {
    const home = fixture(t)
    const calls = join(home, 'calls')
    const result = bash(`
      curl() {
        case "$2" in *uv-installer.sh) echo 'APP_VERSION="0.13.0"'; return;; esac
        echo "$2" >> "$CALLS"
        case "$MODE" in transport) return 22;; io) return 23;; esac
        while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then printf bad > "$2"; return; fi; shift; done
      }
      tar() { echo UNEXPECTED_EXTRACTION; return 99; }
      install_fixed_uv x86_64-unknown-linux-gnu deadbeef
    `, { HOME: home, TMPDIR: home, CALLS: calls, MODE: mode })
    assert.notEqual(result.status, 0)
    const urls = readFileSync(calls, 'utf8').trim().split('\n')
    assert.equal(urls.length, mode === 'transport' ? 2 : 1)
    assert.match(urls[0], /mirrors\.ustc/)
    if (mode === 'transport') assert.match(urls[1], /github\.com/)
    assert.doesNotMatch(result.stdout, /UNEXPECTED_EXTRACTION/)
    assert.deepEqual(readdirSync(home), ['calls'])
  }
})
test('new release dependency helper graph must be complete', async t => {
  const { verifyReleasePackage } = await import('../release-package.mjs')
  const root = fixture(t)
  const files = ['cli.mjs', 'package.json', 'dist/cli/main.js', 'scripts/start.mjs', 'crabot-memory/pyproject.toml', 'crabot-memory/uv.lock', 'scripts/check-release.mjs', 'scripts/installer-deps.mjs']
  for (const file of files) { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), '') }
  await assert.rejects(verifyReleasePackage(root, 'pr-test'), /missing scripts\/prepare-memory\.mjs/)
})

test('system install rejects an incapable uv before dependency replacement', unix, () => {
  const result = bash(`sudo() { return 0; }; uv() { return 2; }; ensure_system_uv; echo UNEXPECTED_PREPARATION`)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /System uv cannot prepare/)
  assert.doesNotMatch(result.stdout, /UNEXPECTED_PREPARATION/)
})

test('healthy Corepack avoids Windows PATH discovery; localized absence is checked only after failure', t => {
  const root = fixture(t)
  for (const mode of ['healthy', 'missing', 'unknown', 'discovery-timeout', 'tmp-missing']) {
    const code = `
      import cp from 'node:child_process';
      import os from 'node:os';
      import { syncBuiltinESMExports } from 'node:module';
      import { EventEmitter } from 'node:events';
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const mode = process.env.TEST_MODE; let where = 0;
      if(mode==='tmp-missing')os.tmpdir=()=>process.env.TEST_ROOT+'/does-not-exist';
      cp.execFileSync = () => { where++; if(mode==='missing')throw Object.assign(new Error('absent'),{status:1}); if(mode==='discovery-timeout')throw Object.assign(new Error('scan timed out'),{code:'ETIMEDOUT'}); };
      cp.spawn = () => { const child=new EventEmitter();child.stderr=new EventEmitter();setImmediate(()=>{if(mode!=='healthy')child.stderr.emit('data',Buffer.from('commande introuvable fixture'));child.emit('close',mode==='healthy'?0:1)});return child; };
      syncBuiltinESMExports();
      const {ensureCorepack}=await import(process.env.TOOLCHAIN_MODULE);
      let failure;try {const value=await ensureCorepack(process.env.TEST_ROOT,{source:{kind:'npm',url:'https://registry.npmmirror.com',domestic:'https://registry.npmmirror.com',official:'https://registry.npmjs.org',systemProxy:false,proxy:''},logger:{info(){},warn(){}}});if(value!==null)throw new Error('unexpected private fallback')}catch(error){failure=error}
      if(mode==='healthy'){if(failure||where!==0)throw failure||new Error('healthy Corepack scanned PATH')}
      else if(mode==='tmp-missing'){if(failure?.code!=='ENOENT'||where!==0)throw new Error('configuration I/O failure was treated as Corepack absence')}
      else {if(!failure||where!==1)throw new Error('unresolved failure skipped structured discovery');if(mode!=='missing'&&failure.stderr!=='commande introuvable fixture')throw new Error('original command failure lost')}
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, TEST_MODE: mode, TEST_ROOT: root, TEMP: root, TMP: root, LOCALAPPDATA: root, TOOLCHAIN_MODULE: new URL('../toolchain.mjs', import.meta.url).href } })
    assert.equal(result.status, 0, mode + ': ' + result.stdout + result.stderr)
  }
})


function bundledPathFixture(t) {
  const home = fixture(t), core = join(home, '产品 中文'), installed = join(home, 'installed')
  mkdirSync(join(core, '.product-runtime/node/bin'), { recursive: true })
  copyFileSync(process.execPath, join(core, '.product-runtime/node/bin/node'), constants.COPYFILE_FICLONE)
  chmodSync(join(core, '.product-runtime/node/bin/node'), 0o755)
  mkdirSync(join(installed, 'bin'), { recursive: true })
  writeFileSync(join(installed, 'bin/crabot'), '#!/bin/sh\necho bundled-command\n', { mode: 0o755 })
  return { home, core, installed, env: { HOME: home, TEST_CORE: core, CRABOT_INSTALL_DIR: installed, SHELL: '/bin/bash', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } }
}

test('bundled CLI PATH setup uses its own Node and preserves login preferences without adding nvm', unix, t => {
  const f = bundledPathFixture(t)
  writeFileSync(join(f.home, '.profile'), 'export PRESERVED_PROFILE=present\n')
  mkdirSync(join(f.home, '.nvm')); writeFileSync(join(f.home, '.nvm/nvm.sh'), 'echo must-not-be-added\n')
  for (let i = 0; i < 2; i++) {
    const result = bash('BUNDLED_CORE_DIR="$TEST_CORE"; configure_path', f.env)
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
  const profile = readFileSync(join(f.home, '.profile'), 'utf8')
  assert.ok(profile.startsWith('export PRESERVED_PROFILE=present\n')); assert.doesNotMatch(profile, /NVM_DIR|nvm\.sh/)
  for (const args of [['--login', '-c'], ['-i', '-c']]) {
    const result = spawnSync('/bin/bash', [...args, 'crabot'], { env: { ...process.env, ...f.env }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /bundled-command/)
  }
})

test('bundled PATH setup preserves a broken custom link and rejects a shared writable command directory', unix, t => {
  for (const mode of ['broken-link', 'shared-directory']) {
    const f = bundledPathFixture(t), prefix = join(f.home, '.local/bin'), entry = join(prefix, 'crabot')
    mkdirSync(prefix, { recursive: true })
    if (mode === 'broken-link') symlinkSync('/missing-custom-command', entry)
    else chmodSync(prefix, 0o777)
    const result = bash('BUNDLED_CORE_DIR="$TEST_CORE"; configure_path', f.env)
    assert.notEqual(result.status, 0)
    if (mode === 'broken-link') assert.equal(readlinkSync(entry), '/missing-custom-command')
    else assert.equal(existsSync(entry), false)
    assert.equal(existsSync(join(f.home, '.bashrc')), false)
  }
})


test('remote complete releases use bundled Node before host setup and reject broken payloads', unix, t => {
  for (const mode of ['complete', 'missing-metadata', 'bad-checksum']) {
    const home = fixture(t), payload = join(home, 'payload'), archive = join(home, 'release.tar.gz')
    mkdirSync(join(payload, '.product-runtime/node/bin'), { recursive: true })
    copyFileSync(process.execPath, join(payload, '.product-runtime/node/bin/node'), constants.COPYFILE_FICLONE)
    chmodSync(join(payload, '.product-runtime/node/bin/node'), 0o755)
    if (mode !== 'missing-metadata') writeFileSync(join(payload, 'core-release.json'), '{}')
    mkdirSync(join(payload, 'scripts'))
    writeFileSync(join(payload, 'scripts/install-core.mjs'), "if(!process.argv.includes('--scope=user')||!process.argv.includes('--expected-version=fixture')||!process.argv.some(v=>v.startsWith('--install-root=')))process.exit(98);console.log('BUNDLED_INSTALL_ENTRY');process.exit(47)")
    const packed = spawnSync('tar', ['-czf', archive, '-C', home, 'payload'], { encoding: 'utf8' })
    assert.equal(packed.status, 0, packed.stderr)
    const sha = mode === 'bad-checksum' ? '0'.repeat(64) : createHash('sha256').update(readFileSync(archive)).digest('hex')
    const result = bash(`
      curl() {
        local url='' output=''
        while [ "$#" -gt 0 ]; do case "$1" in https:*) url="$1";; -o) shift; output="$1";; esac; shift; done
        case "$url" in *.sha256) printf '%s  %s\n' "$FIXTURE_SHA" "$(basename "\${url%.sha256}")" > "$output";; *) cp "$FIXTURE_ARCHIVE" "$output";; esac
      }
      ensure_node() { echo UNEXPECTED_HOST_NODE; return 88; }
      ensure_uv() { echo UNEXPECTED_HOST_UV; return 88; }
      main
    `, { HOME: home, TMPDIR: home, CRABOT_VERSION: 'fixture', CRABOT_INSTALL_DIR: join(home, 'installed'), FIXTURE_ARCHIVE: archive, FIXTURE_SHA: sha })
    const output = result.stdout + result.stderr
    assert.notEqual(result.status, 0, output)
    assert.doesNotMatch(output, /UNEXPECTED_HOST/)
    if (mode === 'complete') assert.match(output, /BUNDLED_INSTALL_ENTRY/)
    else {
      assert.doesNotMatch(output, /BUNDLED_INSTALL_ENTRY/)
      assert.match(output, mode === 'missing-metadata' ? /metadata is missing/ : /Checksum verification failed/)
    }
    assert.equal(existsSync(join(home, 'installed')), false)
    assert.deepEqual(readdirSync(home).filter(name => name.startsWith('crabot-install.')), [])
  }
})


test('PowerShell 5.1 and 7 remote complete releases bypass host prerequisites and preserve failed installs', { skip: process.platform !== 'win32' }, t => {
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('./remote-installer.ps1', import.meta.url)), '-Installer', installer.replace(/install\.sh$/, 'install.ps1'), '-Node', process.execPath],
    { encoding: 'utf8', timeout: 120_000 })
    assert.equal(result.status, 0, shell + ': ' + result.stdout + result.stderr)
  }
})
