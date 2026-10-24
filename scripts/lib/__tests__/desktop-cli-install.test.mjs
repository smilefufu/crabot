import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import management from '../desktop-management.cjs'
import { installDesktopCli } from '../desktop-cli-install.mjs'
import { writeCoreRelease } from '../core-release.mjs'

const windows = process.platform === 'win32'
const isolatedOnly = { skip: windows && process.env.GITHUB_ACTIONS !== 'true' }
async function fixture(t, shell = 'zsh') {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot 命令 ')))
  t.after(() => fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const home = path.join(temporary, '用户'), dataDir = management.ensurePrivateDataRoot(path.join(temporary, '数据'))
  const coreRoot = path.join(temporary, 'Crabot.app/Contents/Resources/core')
  management.ensurePrivateDataRoot(home)
  await fs.mkdir(path.join(coreRoot, '.product-runtime/node/bin'), { recursive: true }); await fs.mkdir(path.join(coreRoot, 'bin'))
  const node = path.join(coreRoot, windows ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
  await fs.copyFile(process.execPath, node, constants.COPYFILE_FICLONE)
  if (!windows) await fs.chmod(node, 0o755)
  await fs.writeFile(path.join(coreRoot, 'cli.mjs'), 'console.log(JSON.stringify({args:process.argv.slice(2),executable:process.execPath}))')
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  await fs.writeFile(path.join(coreRoot, 'bin/crabot'), '#!/bin/sh\nexec ' + quote(node) + ' ' + quote(path.join(coreRoot, 'cli.mjs')) + ' "$@"\n', { mode: 0o755 })
  for (const file of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(coreRoot, file), '{"version":"1.2.3"}')
  const executable = process.platform === 'darwin' ? path.resolve(coreRoot, '../../MacOS/Crabot')
    : path.resolve(coreRoot, '../..', windows ? 'Crabot.exe' : 'crabot-desktop')
  await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.writeFile(executable, 'fixture-only')
  await fs.writeFile(path.join(coreRoot, 'desktop-host.json'), JSON.stringify({ schema_version: 1, platform: process.platform, arch: process.arch }))
  await writeCoreRelease(coreRoot, { schema_version: 1, version: '1.2.3', platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  const env = { ...process.env, HOME: home, SHELL: '/bin/' + shell, PATH: windows ? process.env.SystemRoot + '\\System32' : '/usr/bin:/bin',
    LOCALAPPDATA: path.join(home, 'AppData/Local'), CRABOT_PORT_OFFSET: '0', CRABOT_DEV: 'false' }
  delete env.ZDOTDIR
  const prefix = windows ? path.join(env.LOCALAPPDATA, 'Crabot/cli') : path.join(home, '.local/bin')
  return { coreRoot, dataDir, home, env, prefix, node }
}

test('native-menu registration is idempotent and the installed command uses its bundled interpreter', isolatedOnly, async t => {
  const f = await fixture(t)
  if (!windows) await fs.writeFile(path.join(f.home, '.zshrc'), '# user preferences\nexport KEEP_ME=yes\n')
  const first = await installDesktopCli(f), second = await installDesktopCli(f)
  assert.equal(second.command, first.command)
  const args = ['status', '中文 空格', 'literal&value', "quote'value"]
  if (!windows) {
    const output = await promisify(execFile)(first.command, args, { env: f.env })
    const result = JSON.parse(output.stdout)
    assert.deepEqual(result.args, args); assert.equal(result.executable, f.node)
    const rc = await fs.readFile(path.join(f.home, '.zshrc'), 'utf8')
    assert.ok(rc.startsWith('# user preferences\nexport KEEP_ME=yes\n'))
    assert.equal(rc.split('# >>> Crabot desktop CLI >>>').length, 2)
    assert.match(await fs.readFile(path.join(f.home, '.zprofile'), 'utf8'), /HOME\/\.local\/bin/)
  } else {
    const command = await fs.readFile(first.command, 'utf8')
    assert.match(command, /DisableDelayedExpansion/)
    assert.equal(await fs.realpath(path.join(f.prefix, '.crabot-desktop-core')), f.coreRoot)
    // Keep cmd.exe's own command-line quoting out of this assertion: the probe
    // refers to the installed Unicode/spaced launcher through a quoted env var.
    const probe = await fs.mkdtemp(path.join(tmpdir(), 'crabot-cli-cmd-probe-'))
    t.after(() => fs.rm(probe, { recursive: true, force: true }))
    const script = path.join(probe, 'run.cmd')
    await fs.writeFile(script, '@echo off\r\ncall "%CRABOT_TEST_CLI%" status --json\r\nexit /b %errorlevel%\r\n')
    const output = await promisify(execFile)(path.join(process.env.SystemRoot, 'System32/cmd.exe'), ['/d', '/c', script],
      { env: { ...f.env, CRABOT_TEST_CLI: first.command }, windowsHide: true })
    const result = JSON.parse(output.stdout)
    assert.deepEqual(result.args, ['status', '--json']); assert.equal(await fs.realpath(result.executable), f.node)
  }
})

test('an existing custom command is preserved together with shell preferences', isolatedOnly, async t => {
  const f = await fixture(t)
  if (windows) management.ensurePrivateDataRoot(f.prefix)
  else await fs.mkdir(f.prefix, { recursive: true })
  const entry = path.join(f.prefix, windows ? 'crabot.cmd' : 'crabot')
  await fs.writeFile(entry, 'custom-launcher')
  await assert.rejects(installDesktopCli(f), { code: 'CRABOT_CLI_INSTALL_REQUIRED' })
  assert.equal(await fs.readFile(entry, 'utf8'), 'custom-launcher')
  await assert.rejects(fs.lstat(path.join(f.prefix, '.crabot-desktop-cli.json')), { code: 'ENOENT' })
})

test('a command in another PATH directory requires explicit takeover rather than competing registration', isolatedOnly, async t => {
  const f = await fixture(t), other = path.join(f.home, 'other-tools')
  await fs.mkdir(other); await fs.writeFile(path.join(other, windows ? 'crabot.cmd' : 'crabot'), 'known-other-entry')
  f.env.PATH = other + path.delimiter + f.env.PATH
  await assert.rejects(installDesktopCli(f), { code: 'CRABOT_CLI_INSTALL_REQUIRED' })
  await assert.rejects(fs.lstat(path.join(f.prefix, windows ? 'crabot.cmd' : 'crabot')), { code: 'ENOENT' })
})

test('bash login and non-login configuration retain existing content; modified managed blocks are not overwritten', { skip: windows }, async t => {
  const f = await fixture(t, 'bash')
  await fs.writeFile(path.join(f.home, '.profile'), '# existing login configuration\n')
  await installDesktopCli(f)
  assert.ok((await fs.readFile(path.join(f.home, '.profile'), 'utf8')).startsWith('# existing login configuration\n'))
  assert.match(await fs.readFile(path.join(f.home, '.bashrc'), 'utf8'), /Crabot desktop CLI/)
  await assert.rejects(fs.lstat(path.join(f.home, '.bash_profile')), { code: 'ENOENT' })
  const changed = '# >>> Crabot desktop CLI >>>\ncustom-content\n# <<< Crabot desktop CLI <<<\n'
  await fs.writeFile(path.join(f.home, '.bashrc'), changed)
  await assert.rejects(installDesktopCli(f), { code: 'CRABOT_CLI_INSTALL_REQUIRED' })
  assert.equal(await fs.readFile(path.join(f.home, '.bashrc'), 'utf8'), changed)
})
test('a command directory writable by other accounts is preserved without registering an entry', { skip: windows }, async t => {
  const f = await fixture(t)
  await fs.mkdir(f.prefix, { recursive: true }); await fs.chmod(f.prefix, 0o777)
  await assert.rejects(installDesktopCli(f), { code: 'CRABOT_CLI_INSTALL_REQUIRED' })
  assert.equal((await fs.stat(f.prefix)).mode & 0o777, 0o777)
  await assert.rejects(fs.lstat(path.join(f.prefix, 'crabot')), { code: 'ENOENT' })
})


test('command registration never creates missing desktop data', isolatedOnly, async t => {
  const f = await fixture(t)
  await fs.rm(f.dataDir, { recursive: true })
  await assert.rejects(installDesktopCli(f))
  await assert.rejects(fs.lstat(f.dataDir), { code: 'ENOENT' })
})
