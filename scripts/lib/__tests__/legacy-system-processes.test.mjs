import test from 'node:test'
import assert from 'node:assert/strict'
import { planSystemConversion } from '../system-conversion.mjs'
import { usesLegacySystemCode, collectLegacySystemProcesses, assertLegacySystemProcessCoverage } from '../legacy-system-processes.mjs'
const root = '/opt/crabot-old'
const processRecord = (pid, parent, uid = 1001) => ({ pid, parent, owner: String(uid), started: 'native-metadata-fixture:' + pid, executable: '/usr/bin/node' })
function fixture() {
  const controller = processRecord(10, 1), mm = processRecord(11, 10)
  const entry = { user: 'alice', uid: 1001, gid: 1001, home: '/home/alice', data_dir: '/srv/alice', port_offset: 100, enabled: true, autostart: false }
  const source = { version: 'v2026.10.15.1', installRoot: root, code_fingerprint: 'a'.repeat(64) }, target = { version: '1.2.4', id: 'b'.repeat(64) }
  const observation = { uid: entry.uid, user: entry.user, port_offset: entry.port_offset, install_root: root, code_fingerprint: source.code_fingerprint,
    manifest_fingerprint: 'c'.repeat(64), data_dir: entry.data_dir, data_directory: { device: '1', inode: '2' },
    runtime_state: 'running', data_binding: 'observed_running', controller, mm, mm_port: 19100, launch_kind: 'daemon' }
  const plan = planSystemConversion({ installRoot: '/opt/crabot-managed', source, target, instances: [{ entry, observation }] })
  const row = (current, used = true) => ({ process: current, uses_source: used })
  return { plan, controller, mm, row, rows: [row(controller), row(mm), row(processRecord(12, 11)), row(processRecord(13, 12), false)] }
}
test('original same-UID trees are covered without persisting command or business arguments', () => {
  const f = fixture()
  assert.equal(assertLegacySystemProcessCoverage(f.plan, f.rows), undefined)
  assert.deepEqual(Object.keys(f.rows[0]), ['process', 'uses_source'])
})
for (const changed of ['omitted-uid', 'orphan-module', 'second-controller', 'foreign-child', 'replacement', 'missing-mm', 'changed-parent']) {
  test('source coverage refuses an incomplete or changed original plan: ' + changed, () => {
    const f = fixture()
    if (changed === 'omitted-uid') f.rows.push(f.row(processRecord(20, 1, 1002)))
    if (changed === 'orphan-module') f.rows.push(f.row(processRecord(20, 1)))
    if (changed === 'second-controller') f.rows.push(f.row(processRecord(20, 10, 1002)))
    if (changed === 'foreign-child') f.rows.push(f.row(processRecord(20, 12, 1002)))
    if (changed === 'replacement') f.rows[1].process = { ...f.mm, started: 'replacement' }
    if (changed === 'missing-mm') f.rows.splice(1, 1)
    if (changed === 'changed-parent') f.rows[1].process = { ...f.mm, parent: 99 }
    assert.throws(() => assertLegacySystemProcessCoverage(f.plan, f.rows), { code: 'CRABOT_LEGACY_SYSTEM_PROCESSES' })
  })
}
test('an empty old table cannot approve an actual shared-code user, but a fully stopped source can settle', () => {
  const f = fixture(), empty = { ...f.plan, instances: [] }
  assert.throws(() => assertLegacySystemProcessCoverage(empty, f.rows), { code: 'CRABOT_LEGACY_SYSTEM_PROCESSES' })
  assert.equal(assertLegacySystemProcessCoverage(empty, []), undefined)
  assert.throws(() => assertLegacySystemProcessCoverage(f.plan, f.rows, { stopped: true }))
  assert.throws(() => assertLegacySystemProcessCoverage(f.plan, [f.rows[2]], { stopped: true }))
  assert.equal(assertLegacySystemProcessCoverage(f.plan, [], { stopped: true }), undefined)
})
test('unrelated processes are excluded, while PID reuse cannot be counted as the original runner', () => {
  const f = fixture(), unrelated = f.row(processRecord(20, 1, 1002), false)
  assert.equal(assertLegacySystemProcessCoverage(f.plan, [...f.rows, unrelated]), undefined)
  assert.equal(assertLegacySystemProcessCoverage(f.plan, [{ ...f.rows[0], uses_source: false, process: { ...f.controller, started: 'replacement' } }], { stopped: true }), undefined)
  assert.throws(() => assertLegacySystemProcessCoverage(f.plan, [f.rows[0], f.rows[0]]))
})
test('path classification is lexical only and covers actual code, relative entries, flagged imports and commands', () => {
  const current = processRecord(1, 0)
  for (const [args, cwd] of [[['node', root + '/crabot-core/dist/main.js'], '/'], [['node', 'dist/main.js'], root + '/crabot-core'],
    [['node', '--require=' + root + '/module.js'], '/'], [['sh', '-c', 'node ' + root + '/cli.mjs start'], '/']]) {
    assert.equal(usesLegacySystemCode(root, current, args, cwd), true)
  }
  assert.equal(usesLegacySystemCode(root, { ...current, executable: root + '/node/bin/node' }, ['node', '-e', '0'], '/'), true)
  assert.equal(usesLegacySystemCode(root, current, ['node', root + '-other/main.js'], '/'), false)
  assert.equal(usesLegacySystemCode(root, current, ['node', 'dist/main.js'], root + '-other'), false)
})
test('a passive administrator login shell is not an old runtime, but command/script shells are', () => {
  const shell = { ...processRecord(1, 0), executable: '/bin/bash' }
  for (const args of [['bash'], ['-bash', '-l'], ['bash', '-il']]) assert.equal(usesLegacySystemCode(root, shell, args, root), false)
  for (const args of [['bash', 'launcher.sh'], ['bash', '-c', 'sleep 60']]) assert.equal(usesLegacySystemCode(root, shell, args, root), true)
})
test('native root metadata collection is unavailable on a developer or non-root host', { skip: process.platform === 'linux' && process.getuid() === 0 }, t => {
  // Guarding happens before native process enumeration or procfs access.
  assert.throws(() => collectLegacySystemProcesses(root), { code: 'CRABOT_LEGACY_SYSTEM_PROCESSES' })
})
