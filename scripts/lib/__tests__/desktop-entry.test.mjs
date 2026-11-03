import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import identity from '../process-identity.cjs'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../desktop-entry.cjs', import.meta.url), 'utf8')
function fixture(t, platform = 'linux') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'Crabot identity ')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const executable = join(root, 'Electron binary'), entry = join(root, '完整 source directory')
  writeFileSync(executable, 'not executed'); mkdirSync(entry)
  const peer = { pid: 12345, owner: '1001', executable, started: 'boot:1234', parent: 123 }
  const state = { args: [], actual: peer }
  const native = { ...identity, inspectProcess: pid => pid === process.pid ? { owner: peer.owner } : state.actual,
    inspectProcessArguments: () => state.args }
  const module = { exports: {} }
  runInNewContext(source, { module, process: { pid: process.pid, platform },
    require: name => name === './process-identity.cjs' ? native : require(name) })
  return { ...module.exports, peer, state, policy: { executable, development: true, entry } }
}

test('Linux accepts the observed Electron process title with complete paths containing spaces', t => {
  const f = fixture(t), { executable, entry } = f.policy
  for (const flags of ['', ' --background', ' --check-updates', ' --background --check-updates', ' --check-updates --background']) {
    f.state.args = [`${executable}${flags} ${entry}`]
    assert.equal(f.verifyDesktopEntry(f.peer, f.policy), true, f.state.args[0])
  }
})

test('Linux process-title compatibility rejects unknown flags and other entry paths', t => {
  const f = fixture(t), { executable, entry } = f.policy
  for (const title of [
    `${executable} --remote-debugging-port=23456 ${entry}`, `${executable} --uninstall ${entry}`,
    `${executable} --background ${entry}/other`, `${executable} --background ${entry} extra`,
    `${executable} other ${entry}`, `${executable} ${entry} --background`,
    `${executable}-other --background ${entry}`, `other ${executable} --background ${entry}`,
    `${executable} --background`, `${executable} --background \"${entry}\"`,
  ]) {
    f.state.args = [title]
    assert.equal(f.verifyDesktopEntry(f.peer, f.policy), false, title)
  }
})

test('Linux installed process titles allow only existing ordinary GUI switches', t => {
  const f = fixture(t), policy = { executable: f.policy.executable, development: false }
  for (const flags of ['', ' --background', ' --check-updates', ' --background --check-updates']) {
    f.state.args = [policy.executable + flags]
    assert.equal(f.verifyDesktopEntry(f.peer, policy), true)
  }
  for (const flags of [' --uninstall', ' --remote-debugging-port=23456', ' extra', ` ${f.policy.entry}`]) {
    f.state.args = [policy.executable + flags]
    assert.equal(f.verifyDesktopEntry(f.peer, policy), false, flags)
  }
})

test('all platforms retain separate argv and native owner, executable and generation checks', t => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const f = fixture(t, platform)
    f.state.args = [f.policy.executable, f.policy.entry, '--background']
    assert.equal(f.verifyDesktopEntry(f.peer, f.policy), true)
    assert.equal(f.verifyDesktopEntry({ ...f.peer, owner: 'other' }, f.policy), false)
    assert.equal(f.verifyDesktopEntry({ ...f.peer, executable: f.policy.entry }, f.policy), false)
    for (const changed of [{ started: 'reused PID' }, { pid: 54321 }, { owner: 'other' }, { executable: f.policy.entry }]) {
      f.state.actual = { ...f.peer, ...changed }
      assert.equal(f.verifyDesktopEntry(f.peer, f.policy), false)
    }
    f.state.actual = null
    assert.equal(f.verifyDesktopEntry(f.peer, f.policy), false)
    f.state.actual = f.peer
    f.state.args.push('--unknown')
    assert.equal(f.verifyDesktopEntry(f.peer, f.policy), false)
    if (platform !== 'linux') {
      f.state.args = [`${f.policy.executable} --background ${f.policy.entry}`]
      assert.equal(f.verifyDesktopEntry(f.peer, f.policy), false)
    }
  }
})
