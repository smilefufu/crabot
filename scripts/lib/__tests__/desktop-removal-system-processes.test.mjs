import test from 'node:test'
import assert from 'node:assert/strict'
import identity from '../process-identity.cjs'
import { captureMacRemovalSystemProcesses, captureLinuxRemovalSystemProcesses } from '../desktop-removal-system-processes.mjs'
function fixture() {
  const root = '/Users/example/Crabot', owner = '502', service = { pid: 50, parent: 1, owner, started: '100:1', executable: '/usr/libexec/service' }
  const items = new Map([[service.pid, service], [process.pid, { pid: process.pid, owner }]])
  const api = { listProcessIds: () => [...items.keys()], inspectProcess: pid => items.get(pid) && { ...items.get(pid) }, sameProcess: identity.sameProcess }
  const stat = { uid: 0, mode: 0o100755, isFile: () => true, isSymbolicLink: () => false }
  const fs = { realpathSync: file => file, lstatSync: () => ({ ...stat }) }
  const observation = { complete: false, incomplete: false, processes: [], unknown_pids: [50],
    unknown_details: [{ pid: 50, stage: 'descriptor_details', os_error: 1 }] }
  return { root, api, fs, service, items, stat, observation }
}
for (const prefix of ['/System/Library', '/System/Applications', '/usr/bin', '/usr/sbin', '/usr/libexec', '/bin', '/sbin']) {
  test('canonical root-owned fixed macOS system image: ' + prefix, () => {
    const f = fixture(); f.service.executable = prefix + '/tool'
    const before = structuredClone(f.observation), classify = captureMacRemovalSystemProcesses(f.root, f.api, f.fs)
    assert.equal(classify(f.observation), true); assert.deepEqual(f.observation, before)
  })
}
for (const image of ['/usr/local/bin/tool', '/System/Volumes/Data/tool', '/System/Library-other/tool', '/usr/libexec-other/tool',
  '/Applications/tool', '/Users/example/tool', '/usr/bin/../libexec/tool', 'service']) test('non-system or noncanonical image stays unknown: ' + image, () => {
  const f = fixture(); f.service.executable = image
  assert.equal(captureMacRemovalSystemProcesses(f.root, f.api, f.fs)(f.observation), false)
})
for (const mode of ['alias', 'writable', 'non-root', 'directory', 'symlink', 'missing-image', 'unknown-image', 'other-owner', 'missing-parent', 'cycle', 'crabot-ancestor', 'own-installation']) {
  test('unverified image or related chain keeps removal blocked: ' + mode, () => {
    const f = fixture()
    if (mode === 'alias') f.fs.realpathSync = () => '/Users/example/tool'
    if (mode === 'writable') f.stat.mode |= 0o020
    if (mode === 'non-root') f.stat.uid = 502
    if (mode === 'directory') f.stat.isFile = () => false
    if (mode === 'symlink') f.stat.isSymbolicLink = () => true
    if (mode === 'missing-image') f.fs.lstatSync = () => { throw new Error('unavailable') }
    if (mode === 'unknown-image') f.api.inspectProcess = () => { throw new Error('unavailable') }
    if (mode === 'other-owner') f.service.owner = '503'
    if (mode === 'missing-parent') f.service.parent = 99
    if (mode === 'cycle') f.service.parent = 50
    if (mode === 'crabot-ancestor') { f.service.parent = 60; f.items.set(60, { ...f.service, pid: 60, parent: 1, executable: f.root + '/releases/node' }) }
    if (mode === 'own-installation') f.root = '/usr/libexec'
    assert.equal(captureMacRemovalSystemProcesses(f.root, f.api, f.fs)(f.observation), false)
  })
}
for (const mode of ['pid-reuse', 'parent-changed', 'image-changed', 'owner-changed', 'exited', 'identity-error', 'file-changed',
  'referenced', 'truncated', 'wrong-stage', 'not-protected', 'missing-reason', 'duplicate-pid', 'extra-unknown', 'reason-mismatch', 'complete-contradiction', 'invalid-process-list']) {
  test('late facts and raw unknowns cannot be promoted into a complete receipt: ' + mode, () => {
    const f = fixture(), classify = captureMacRemovalSystemProcesses(f.root, f.api, f.fs)
    if (mode === 'pid-reuse') f.service.started = '101:1'
    if (mode === 'parent-changed') f.service.parent = 60
    if (mode === 'image-changed') f.service.executable = '/bin/other'
    if (mode === 'owner-changed') f.service.owner = '503'
    if (mode === 'exited') f.items.delete(50)
    if (mode === 'identity-error') f.api.inspectProcess = () => { throw new Error('unavailable') }
    if (mode === 'file-changed') f.stat.mode |= 0o002
    if (mode === 'referenced') f.observation.processes.push({ ...f.service })
    if (mode === 'truncated') f.observation.incomplete = true
    if (mode === 'wrong-stage') f.observation.unknown_details[0].stage = 'mappings'
    if (mode === 'not-protected') f.observation.unknown_details[0].os_error = 5
    if (mode === 'missing-reason') delete f.observation.unknown_details
    if (mode === 'duplicate-pid') f.observation.unknown_pids.push(50)
    if (mode === 'extra-unknown') { f.observation.unknown_pids.push(99); f.observation.unknown_details.push({ pid: 99, stage: 'descriptor_details', os_error: 1 }) }
    if (mode === 'reason-mismatch') f.observation.unknown_details[0].pid = 99
    if (mode === 'invalid-process-list') f.observation.processes = ''
    if (mode === 'complete-contradiction') f.observation.complete = true
    assert.equal(classify(f.observation), false)
  })
}
test('system ancestor is pinned with the service generation', () => {
  const f = fixture(); f.service.parent = 60
  f.items.set(60, { ...f.service, pid: 60, parent: 1, executable: '/usr/libexec/parent' })
  const classify = captureMacRemovalSystemProcesses(f.root, f.api, f.fs)
  assert.equal(classify(f.observation), true)
  f.items.get(60).started = '101:1'; assert.equal(classify(f.observation), false)
})

function linuxFixture() {
  const uid = 1001, root = '/home/example/Crabot', files = new Map(), stats = new Map()
  const group = '/user.slice/user-1001.slice/user@1001.service'
  const service = { MainPID: '50', ExecMainStartTimestampMonotonic: '10501259', ControlGroup: group,
    ExecStart: '{ path=/usr/lib/systemd/systemd ; argv[]=/usr/lib/systemd/systemd --user ; }' }
  function proc(pid, parent, name, start, flags = 0) {
    const fields = Array(50).fill('0'); fields[0] = 'S'; fields[1] = String(parent); fields[6] = String(flags); fields[19] = String(start)
    files.set('/proc/' + pid + '/stat', pid + ' (' + name + ') ' + fields.join(' '))
    files.set('/proc/' + pid + '/cgroup', '0::' + group + '/init.scope\n')
    stats.set('/proc/' + pid, { uid, isDirectory: () => true, isSymbolicLink: () => false })
  }
  proc(50, 1, 'systemd', 1050); proc(51, 50, '(sd-pam)', 1064, 64)
  files.set('/proc/50/task/50/children', '51 ')
  const fs = { readFileSync: name => { if (!files.has(name)) throw new Error('missing'); return files.get(name) },
    realpathSync: name => name,
    lstatSync: name => stats.get(name) || ({ uid: 0, mode: 0o100755, isFile: () => true, isSymbolicLink: () => false }) }
  const run = command => command.endsWith('/getconf') ? '100\n' : Object.entries(service).map(([key, value]) => key + '=' + value).join('\n')
  const observation = { complete: false, incomplete: false, processes: [], unknown_pids: [50, 51],
    unknown_details: [{ pid: 50, stage: 'identity', os_error: 13 }, { pid: 51, stage: 'identity', os_error: 13 }] }
  return { uid, root, fs, run, service, files, stats, observation, proc }
}
test('Linux root system manager and fork-only PAM role classify raw protected unknowns without altering receipts', () => {
  const f = linuxFixture(), before = structuredClone(f.observation)
  const classify = captureLinuxRemovalSystemProcesses(f.root, f.fs, f.run, f.uid)
  assert.equal(classify(f.observation), true); assert.deepEqual(f.observation, before)
})
for (const mode of ['wrong-uid', 'wrong-parent', 'wrong-name', 'execed-pam', 'wrong-group', 'wrong-start', 'wrong-image', 'image-alias',
  'image-writable', 'image-owner', 'own-root', 'manager-unavailable', 'late-generation', 'late-unit', 'late-image', 'reference',
  'unknown-process', 'wrong-error', 'wrong-stage', 'incomplete', 'duplicate-pid', 'missing-reason']) test('Linux protected-role evidence still blocks: ' + mode, () => {
  const f = linuxFixture()
  if (mode === 'wrong-uid') f.stats.get('/proc/51').uid++
  if (mode === 'wrong-parent') f.proc(51, 49, '(sd-pam)', 1064, 64)
  if (mode === 'wrong-name') f.proc(51, 50, 'Crabot', 1064, 64)
  if (mode === 'execed-pam') f.proc(51, 50, '(sd-pam)', 1064, 0)
  if (mode === 'wrong-group') f.files.set('/proc/51/cgroup', '0::/user.slice/other.service')
  if (mode === 'wrong-start') f.service.ExecMainStartTimestampMonotonic = '90000000'
  if (mode === 'wrong-image') f.service.ExecStart = '{ path=/home/example/systemd ; }'
  if (mode === 'image-alias') f.fs.realpathSync = () => '/home/example/systemd'
  if (mode === 'image-writable') f.fs.lstatSync = () => ({ uid: 0, mode: 0o100777, isFile: () => true, isSymbolicLink: () => false })
  if (mode === 'image-owner') f.fs.lstatSync = () => ({ uid: 1001, mode: 0o100755, isFile: () => true, isSymbolicLink: () => false })
  if (mode === 'own-root') f.root = '/usr/lib/systemd'
  if (mode === 'manager-unavailable') f.run = () => { throw new Error('unavailable') }
  const classify = captureLinuxRemovalSystemProcesses(f.root, f.fs, f.run, f.uid)
  if (mode === 'late-generation') f.proc(51, 50, '(sd-pam)', 1100, 64)
  if (mode === 'late-unit') f.service.MainPID = '52'
  if (mode === 'late-image') f.service.ExecStart = '{ path=/home/example/systemd ; }'
  if (mode === 'reference') f.observation.processes.push({ pid: 50 })
  if (mode === 'unknown-process') { f.observation.unknown_pids.push(52); f.observation.unknown_details.push({ pid: 52, stage: 'identity', os_error: 13 }) }
  if (mode === 'wrong-error') f.observation.unknown_details[0].os_error = 5
  if (mode === 'wrong-stage') f.observation.unknown_details[0].stage = 'mappings'
  if (mode === 'incomplete') f.observation.incomplete = true
  if (mode === 'duplicate-pid') f.observation.unknown_pids.push(50)
  if (mode === 'missing-reason') delete f.observation.unknown_details
  assert.equal(classify(f.observation), false)
})
