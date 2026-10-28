import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { LegacySystemCommandLink } from '../legacy-system-command.mjs'
import { planSystemConversion } from '../system-conversion.mjs'
import { writeCoreRelease, verifyCoreRelease } from '../core-release.mjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
const options = { skip: process.platform === 'win32' }
async function fixture(t, { locked = true } = {}) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-legacy-command-link-')))
  let lock
  t.after(async () => { releaseCliLock(lock); await fs.rm(parent, { recursive: true, force: true }) })
  const source = path.join(parent, 'old'), install = path.join(parent, 'managed'), staged = path.join(parent, 'staged')
  const directory = path.join(parent, 'metadata'), command = path.join(parent, 'global/crabot')
  for (const dir of [source, path.join(install, 'releases'), path.join(install, 'bin'), staged, directory, path.dirname(command)]) await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(source, 'cli.mjs'), 'old source retained')
  for (const name of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(staged, name), '{"version":"1.2.4"}')
  await writeCoreRelease(staged, { schema_version: 1, version: '1.2.4', platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  const release = await verifyCoreRelease(staged), core = path.join(install, 'releases', release.inventory_sha256)
  await fs.rename(staged, core)
  const launcher = path.join(install, 'bin/crabot'), bytes = 'new launcher fixture - never executed'
  await fs.writeFile(launcher, bytes, { mode: 0o755 })
  await fs.writeFile(path.join(install, 'cli-installation.json'), JSON.stringify({ schema_version: 1, scope: 'system', launcher_sha256: createHash('sha256').update(bytes).digest('hex') }))
  await fs.writeFile(path.join(install, 'current-core'), release.inventory_sha256 + '\n')
  await fs.symlink(path.join(source, 'cli.mjs'), command)
  const plan = planSystemConversion({ installRoot: install, source: { version: 'v2026.10.15.1', installRoot: source, code_fingerprint: 'a'.repeat(64) },
    target: { id: release.inventory_sha256, version: release.version }, instances: [] })
  // Actual current-UID file operations only; this does not prove root authority,
  // old-source recognition or complete Core packaging. No launcher is executed.
  const link = new LegacySystemCommandLink({ command, directory, ownerUid: process.getuid(), checkRoot: () => {} })
  if (locked) lock = await acquireCliLock(directory, 'system-conversion-test')
  return { parent, source, install, core, directory, command, launcher, plan, link }
}
test('known old global link hands off atomically while original source remains at its exact path', options, async t => {
  const f = await fixture(t)
  assert.equal(await f.link.selected(f.plan), 'legacy')
  assert.deepEqual(await f.link.select(f.plan), { selected: true })
  assert.equal(await f.link.selected(f.plan), 'target'); assert.equal(await fs.readlink(f.command), f.launcher)
  assert.equal(await fs.readFile(path.join(f.source, 'cli.mjs'), 'utf8'), 'old source retained')
  await assert.rejects(f.link.select(f.plan), { code: 'CRABOT_LEGACY_SYSTEM_COMMAND' })
})
for (const changed of ['unlocked', 'regular-command', 'unknown-command', 'changed-launcher', 'unselected-core', 'changed-core', 'unowned-command']) test('unsafe command handoff refuses and retains the existing entry: ' + changed, options, async t => {
  const f = await fixture(t, { locked: changed !== 'unlocked' })
  if (changed === 'regular-command') { await fs.unlink(f.command); await fs.writeFile(f.command, 'custom command') }
  if (changed === 'unknown-command') { await fs.unlink(f.command); await fs.symlink(f.launcher + '-custom', f.command) }
  if (changed === 'changed-launcher') await fs.appendFile(f.launcher, ' changed')
  if (changed === 'unselected-core') await fs.writeFile(path.join(f.install, 'current-core'), 'f'.repeat(64) + '\n')
  if (changed === 'changed-core') await fs.appendFile(path.join(f.core, 'package.json'), ' ')
  if (changed === 'unowned-command') f.link.ownerUid++
  const before = await fs.lstat(f.command), original = before.isSymbolicLink() ? await fs.readlink(f.command) : await fs.readFile(f.command, 'utf8')
  await assert.rejects(f.link.select(f.plan))
  const after = await fs.lstat(f.command)
  assert.equal(after.ino, before.ino)
  assert.equal(after.isSymbolicLink() ? await fs.readlink(f.command) : await fs.readFile(f.command, 'utf8'), original)
  assert.deepEqual(await fs.readdir(path.dirname(f.command)), ['crabot'])
})
test('a replaced link during preparation is not overwritten even when it still targets the old source', options, async t => {
  const f = await fixture(t), target = f.link.target.bind(f.link)
  f.link.target = async plan => { const result = await target(plan); await fs.unlink(f.command); await fs.symlink(path.join(f.source, 'cli.mjs'), f.command); return result }
  await assert.rejects(f.link.select(f.plan), { code: 'CRABOT_LEGACY_SYSTEM_COMMAND' })
  assert.equal(await f.link.selected(f.plan), 'legacy'); assert.deepEqual(await fs.readdir(path.dirname(f.command)), ['crabot'])
})
test('post-rename durability failure exposes the actual new state without rollback or automatic replay', options, async t => {
  const f = await fixture(t), open = fs.open.bind(fs)
  const fault = t.mock.method(fs, 'open', async (...args) => {
    if (args[0] === path.dirname(f.command)) throw Object.assign(new Error('controlled directory sync failure'), { code: 'EIO' })
    return open(...args)
  })
  await assert.rejects(f.link.select(f.plan), { code: 'EIO' }); fault.mock.restore()
  assert.equal(await f.link.selected(f.plan), 'target')
  assert.equal(await fs.readFile(path.join(f.source, 'cli.mjs'), 'utf8'), 'old source retained')
  await assert.rejects(f.link.select(f.plan), { code: 'CRABOT_LEGACY_SYSTEM_COMMAND' })
})
test('ordinary users cannot inspect or hand off the real global command through this role', { skip: process.platform === 'linux' && process.getuid() === 0 }, async () => {
  const link = new LegacySystemCommandLink()
  await assert.rejects(link.selected({}), { code: 'CRABOT_SYSTEM_ADMIN_REQUIRED' })
  await assert.rejects(link.select({}), { code: 'CRABOT_SYSTEM_ADMIN_REQUIRED' })
})
