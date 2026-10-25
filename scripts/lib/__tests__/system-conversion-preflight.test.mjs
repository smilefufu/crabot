import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { SystemOperationStore } from '../system-operation.mjs'
import { SystemRegistry } from '../system-registry.mjs'
import { discoverLegacySystemRelease } from '../legacy-system-release.mjs'
import { readLegacySystemHints, resolveLegacySystemCandidates } from '../legacy-system-hints.mjs'
import { preflightLegacySystemConversion } from '../system-conversion-preflight.mjs'
import { materializeLegacyRelease } from './fixtures/legacy-release.mjs'
import { writeCoreRelease, verifyCoreRelease } from '../core-release.mjs'
const options = { skip: process.platform === 'win32' }
async function fixture(t) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-legacy-preflight-')))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const source = path.join(parent, 'old'), installed = path.join(parent, 'managed'), staged = path.join(installed, 'staged'), hintsFile = path.join(parent, 'ports.json')
  for (const name of [source, staged, path.join(installed, 'releases')]) await fs.mkdir(name, { recursive: true })
  await materializeLegacyRelease(source)
  for (const name of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(staged, name), '{"version":"1.2.4"}')
  await writeCoreRelease(staged, { schema_version: 1, version: '1.2.4', platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  const release = await verifyCoreRelease(staged), core = path.join(installed, 'releases', release.inventory_sha256)
  await fs.rename(staged, core)
  await fs.writeFile(path.join(installed, 'cli-installation.json'), JSON.stringify({ schema_version: 1, scope: 'system', launcher_sha256: 'a'.repeat(64) }))
  await fs.writeFile(path.join(installed, 'current-core'), release.inventory_sha256 + '\n')
  const accounts = [1001, 1002].map(uid => ({ user: 'employee' + uid, uid, gid: uid, home: '/home/employee' + uid }))
  const lookup = user => accounts.find(value => value.user === user)
  const hints = accounts.map((account, index) => ({ user: account.user, offset: 100 + index * 100,
    data_dir: '/root/do-not-adopt', pid: 1, command: 'must-not-execute' }))
  await fs.writeFile(hintsFile, JSON.stringify(hints), { mode: 0o664 })
  const registry = new SystemRegistry({ directory: path.join(parent, 'system'), ownerUid: process.getuid(), accountLookup: lookup }), calls = []
  const observations = []
  const args = { root: core + path.sep, sourceRoot: source, registry, checkRoot: () => {},
    readHints: () => readLegacySystemHints({ file: hintsFile, ownerUid: process.getuid() }),
    resolveCandidates: value => resolveLegacySystemCandidates(value, { lookup }),
    discoverRelease: context => discoverLegacySystemRelease({ ...context, platform: 'linux', ownerUid: process.getuid(), checkRoot: () => {} }),
    observe: async (account, { root, release, portOffsetHint }) => {
      assert.equal(root, core); assert.deepEqual(account, lookup(account.user)); calls.push(account.user)
      const result = { user: account.user, uid: account.uid, port_offset: portOffsetHint, install_root: source,
        code_fingerprint: release.code_fingerprint, manifest_fingerprint: 'b'.repeat(64), data_dir: path.join(parent, 'private-' + account.uid),
        data_directory: { device: '1', inode: String(account.uid) }, runtime_state: 'stopped', data_binding: 'verified_stopped' }
      observations.push(result); return result
    },
  }
  return { parent, source, installed, core, release, hintsFile, hints, registry, accounts, observations, calls, args,
    invoke: extra => preflightLegacySystemConversion({ ...args, ...extra }) }
}
test('read-only installer preflight derives only the existing conversion plan from verified code, account hints and dropped-UID bindings', options, async t => {
  const f = await fixture(t), hintBytes = await fs.readFile(f.hintsFile), result = await f.invoke()
  assert.deepEqual(Object.keys(result.plan).sort(), ['schema_version', 'kind', 'id', 'install_root', 'source', 'target', 'instances'].sort())
  assert.equal(result.plan.install_root, f.installed); assert.equal(result.plan.target.id, f.release.inventory_sha256)
  assert.match(result.hints_fingerprint, /^[a-f0-9]{64}$/)
  assert.deepEqual(result.plan.instances.map(item => item.entry.port_offset), [100, 200])
  assert.deepEqual(result.plan.instances.map(item => item.entry.autostart), [false, false])
  assert.deepEqual(result.plan.instances.map(item => item.observation.runtime_state), ['stopped', 'stopped'])
  assert.deepEqual(f.calls, f.accounts.map(account => account.user))
  assert.doesNotMatch(JSON.stringify(result), /do-not-adopt|must-not-execute|"pid":1/)
  for (const { entry } of result.plan.instances) await assert.rejects(fs.lstat(entry.data_dir), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(f.registry.directory), { code: 'ENOENT' })
  assert.deepEqual(await fs.readFile(f.hintsFile), hintBytes)
})
for (const changed of ['target-corrupt', 'unselected-target', 'source-modified', 'duplicate-offset', 'missing-account', 'account-changed', 'wrong-binding', 'unverified-stopped', 'private-extra-field', 'discovery-failed']) {
  test('preflight failure leaves old code, employee directories and managed inventory untouched: ' + changed, options, async t => {
    const f = await fixture(t), sourceEntry = path.join(f.source, 'cli.mjs')
    if (changed === 'target-corrupt') await fs.appendFile(path.join(f.core, 'package.json'), ' ')
    if (changed === 'unselected-target') await fs.writeFile(path.join(f.installed, 'current-core'), 'f'.repeat(64) + '\n')
    if (changed === 'source-modified') await fs.appendFile(sourceEntry, '// local change retained')
    if (changed === 'duplicate-offset') { f.hints[1].offset = f.hints[0].offset; await fs.writeFile(f.hintsFile, JSON.stringify(f.hints)) }
    if (changed === 'missing-account') f.args.resolveCandidates = value => resolveLegacySystemCandidates(value, { lookup: () => { throw Error('missing') } })
    if (changed === 'account-changed') f.registry.accountLookup = user => ({ ...f.accounts.find(account => account.user === user), uid: 9001 })
    const observe = f.args.observe
    if (['wrong-binding', 'unverified-stopped', 'private-extra-field', 'discovery-failed'].includes(changed)) f.args.observe = async (...args) => {
      if (changed === 'discovery-failed') throw Error('controlled observation failure')
      const result = await observe(...args)
      if (changed === 'wrong-binding') result.uid++
      if (changed === 'unverified-stopped') result.data_binding = 'unverified'
      if (changed === 'private-extra-field') result.api_key = 'must-not-persist'
      return result
    }
    const before = await fs.readFile(sourceEntry)
    await assert.rejects(f.invoke())
    assert.deepEqual(await fs.readFile(sourceEntry), before)
    await assert.rejects(fs.lstat(f.registry.directory), { code: 'ENOENT' })
    for (const account of f.accounts) await assert.rejects(fs.lstat(path.join(f.parent, 'private-' + account.uid)), { code: 'ENOENT' })
    if (!['wrong-binding', 'unverified-stopped', 'private-extra-field'].includes(changed)) assert.equal(f.calls.length, 0)
  })
}

for (const existing of ['managed-user', 'unfinished-job', 'partial-registry']) test('preflight never clears or replaces existing managed state: ' + existing, options, async t => {
  const f = await fixture(t)
  if (existing === 'partial-registry') await fs.mkdir(f.registry.directory)
  else {
    const { plan } = await f.invoke(); f.calls.length = 0
    const entries = existing === 'managed-user' ? [plan.instances[0].entry] : []
    await f.registry.update(() => entries, { create: true })
    if (existing === 'unfinished-job') await new SystemOperationStore(f.registry).prepare(plan)
  }
  const names = await fs.readdir(f.registry.directory)
  await assert.rejects(f.invoke()); assert.equal(f.calls.length, 0)
  assert.deepEqual(await fs.readdir(f.registry.directory), names)
  if (existing === 'managed-user') assert.equal(f.registry.read().length, 1)
  if (existing === 'unfinished-job') assert.equal(new SystemOperationStore(f.registry).maintenance().phase, 'prepared')
})
