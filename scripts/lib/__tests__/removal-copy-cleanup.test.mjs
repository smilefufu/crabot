import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import identity from '../process-identity.cjs'
import management from '../desktop-management.cjs'
import { probeKnownProcessExit } from '../known-process-exit.cjs'
const windows = process.platform === 'win32'
const native = fileURLToPath(new URL('../../../crabot-native/build/Release/crabot-copy-cleanup' + (windows ? '.exe' : ''), import.meta.url))
async function fixture(t) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-cleanup-unit-')))
  const root = management.ensurePrivateDataRoot(path.join(parent, 'crabot-removal-host-' + randomUUID()))
  const helper = path.join(root, 'cleanup' + (windows ? '.exe' : ''))
  if (windows) { identity.writePrivateFile(helper, ''); await fs.writeFile(helper, await fs.readFile(native)) }
  else await fs.copyFile(native, helper)
  const fixture = { parent, root, helper, close: async () => {} }
  t.after(async () => { await fixture.close(); await fs.rm(parent, { recursive: true, force: true }) })
  return fixture
}
test('the cleanup binary rejects an unrelated parent without touching the private copy', async t => {
  const f = await fixture(t), file = path.join(f.root, 'preserve')
  await fs.writeFile(file, 'not a maintenance host')
  await assert.rejects(promisify(execFile)(f.helper, [], { cwd: f.parent, timeout: 5000 }), error => error.code === 1)
  assert.equal(await fs.readFile(file, 'utf8'), 'not a maintenance host')
})
for (const mode of ['complete', 'changed-file', 'unknown-file', 'profile-symlink']) test('native private-copy exit and closed-file scope: ' + mode,
  { skip: windows && mode === 'profile-symlink', timeout: 20000 }, async t => {
    const f = await fixture(t)
    const gui = path.join(f.root, process.platform === 'linux' ? 'backend' : 'gui')
    const executable = process.platform === 'darwin' ? path.join(gui, 'Crabot.app/Contents/MacOS/Crabot') : windows ? path.join(gui, 'Crabot.exe') : path.join(f.root, 'node')
    let args = [f.helper]
    if (windows) {
      management.ensurePrivateDataRoot(gui)
      // A finite native-image parent, not a GUI or business runtime. Preserve
      // current-user ownership even on the elevated Windows CI account.
      identity.writePrivateFile(executable, ''); await fs.writeFile(executable, await fs.readFile(process.execPath))
      args = [fileURLToPath(new URL('../../../crabot-desktop/tests/fixtures/removal-cleanup-parent.mjs', import.meta.url)), f.helper]
    } else {
      await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.mkdir(gui, { recursive: true })
      await promisify(execFile)('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
        fileURLToPath(new URL('../../../crabot-desktop/tests/native/removal-cleanup-parent.c', import.meta.url)), '-o', executable], { timeout: 10000 })
    }
    const file = path.join(gui, 'asset'), profile = path.join(f.root, 'profile'), outside = path.join(f.parent, 'outside')
    if (windows) { identity.writePrivateFile(file, 'copied asset'); management.ensurePrivateDataRoot(profile); identity.writePrivateFile(path.join(profile, 'cache'), 'private display cache') }
    else { await fs.writeFile(file, 'copied asset'); await fs.mkdir(profile); await fs.writeFile(path.join(profile, 'cache'), 'private display cache') }
    await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'precious'), 'outside user files')
    const child = spawn(executable, args, { cwd: f.parent, stdio: ['pipe', 'pipe', 'pipe'] }), parent = identity.inspectProcess(child.pid)
    const exited = once(child, 'exit'); let output = '', errors = '', peer
    child.stderr.on('data', bytes => { errors += bytes.toString() })
    f.close = async () => {
      for (const item of [peer, parent]) if (item && identity.sameProcess(item, identity.inspectProcess(item.pid))) process.kill(item.pid, 'SIGKILL')
      await exited
      if (peer) {
        const deadline = Date.now() + 5000
        while (probeKnownProcessExit([peer]).state !== 'stopped') {
          if (Date.now() > deadline) throw Error('Cleanup fixture exit remains unverified; private files retained')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
    }
    const deadline = Date.now() + 10000
    child.stdout.on('data', bytes => { output += bytes.toString() })
    while (!output.endsWith('READY\n')) {
      const pid = /^CHILD:(\d+)\n/.exec(output)?.[1]
      if (pid && !peer) peer = identity.inspectProcess(Number(pid))
      if (child.exitCode !== null || Date.now() > deadline) throw Error('Native parent not ready: ' + output + errors)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    peer = identity.inspectProcess(Number(/^CHILD:(\d+)\n/.exec(output)[1])); assert.ok(peer)
    assert.equal(peer.parent, parent.pid); assert.equal(await fs.realpath(peer.executable), await fs.realpath(f.helper))
    assert.equal(await fs.readFile(file, 'utf8'), 'copied asset', 'Cleanup waits for the actual parent kernel exit')
    if (mode === 'changed-file') await fs.writeFile(file, 'changed copy retained')
    if (mode === 'unknown-file') await fs.writeFile(path.join(gui, 'unknown'), 'foreign addition')
    if (mode === 'profile-symlink') { await fs.rm(profile, { recursive: true }); await fs.symlink(outside, profile, 'dir') }
    child.stdin.end('q'); assert.equal((await exited)[0], 0)
    while (probeKnownProcessExit([peer]).state !== 'stopped') {
      if (Date.now() > deadline) throw Error('Cleanup child did not exit')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (mode === 'changed-file') assert.equal(await fs.readFile(file, 'utf8'), 'changed copy retained')
    else if (mode === 'unknown-file') assert.equal(await fs.readFile(path.join(gui, 'unknown'), 'utf8'), 'foreign addition')
    else if (mode === 'profile-symlink' && process.platform === 'linux') {
      // Linux has no GUI profile: replacing a captured directory is a changed
      // program-copy object, so retain it rather than treating it as cache.
      assert.equal(await fs.readlink(profile), outside)
    } else if (windows) {
      await assert.rejects(fs.lstat(gui), { code: 'ENOENT' }); await assert.rejects(fs.lstat(profile), { code: 'ENOENT' })
      const remaining = await fs.readdir(f.root).catch(error => { if (error.code === 'ENOENT') return []; throw error })
      assert.ok(remaining.length === 0 || remaining.length === 1 && remaining[0] === 'cleanup.exe')
    } else await assert.rejects(fs.lstat(f.root), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(outside, 'precious'), 'utf8'), 'outside user files')
  })
