// Real ownership/umask regression before large native payloads are assembled.
// Never run on a developer host; this creates no account, service or business MM.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Shared installation ownership acceptance requires an isolated Linux CI root process')
const repository = await fs.realpath(fileURLToPath(new URL('../..', import.meta.url)))
assert.equal(repository, await fs.realpath(process.env.GITHUB_WORKSPACE))
const builder = await fs.stat(path.join(repository, 'scripts/lib/cli-installation.mjs'))
assert.ok(builder.uid > 0, 'the regression must copy files owned by the non-root builder')
const { prepareCliPayload, selectCliPayload, readCliSelection } = await import('../../scripts/lib/cli-installation.mjs')
const { writeCoreRelease, verifyCoreRelease } = await import('../../scripts/lib/core-release.mjs')
const root = '/var/lib/crabot-ownership-' + randomUUID(), source = path.join(root, 'source'), install = path.join(root, 'install')
const previousMask = process.umask(0o077)
let created = false
try {
  await fs.mkdir(root, { mode: 0o755 }); created = true; await fs.chmod(root, 0o755)
  await fs.mkdir(source, { mode: 0o700 })
  for (const directory of ['bin', 'scripts', '.product-runtime', '.product-runtime/node', '.product-runtime/node/bin']) {
    await fs.mkdir(path.join(source, directory), { mode: 0o755 }); await fs.chmod(path.join(source, directory), 0o755)
    await fs.chown(path.join(source, directory), builder.uid, builder.gid)
  }
  const files = {
    // These inert fixture binaries are copied/hashed only and are never executed.
    'bin/crabot': ['fixture-native-launcher', 0o755],
    '.product-runtime/node/bin/node': ['fixture-node', 0o755],
    'scripts/system-user-helper.mjs': ['// fixture helper, never executed', 0o644],
    'package.json': [JSON.stringify({ version: '1.2.3' }), 0o644],
    'product-runtime.json': [JSON.stringify({ version: '1.2.3' }), 0o644],
  }
  for (const [name, [contents, mode]] of Object.entries(files)) {
    const file = path.join(source, name)
    await fs.writeFile(file, contents); await fs.chmod(file, mode); await fs.chown(file, builder.uid, builder.gid)
  }
  await fs.symlink('system-user-helper.mjs', path.join(source, 'scripts/helper-link.mjs'))
  await fs.lchown(path.join(source, 'scripts/helper-link.mjs'), builder.uid, builder.gid)
  await writeCoreRelease(source, { schema_version: 1, version: '1.2.3', platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  for (const name of ['core-release.json', 'core-files.json']) {
    await fs.chmod(path.join(source, name), 0o644); await fs.chown(path.join(source, name), builder.uid, builder.gid)
  }
  const initial = await verifyCoreRelease(source)
  const prepared = await prepareCliPayload({ sourceRoot: source, installRoot: install, scope: 'system' })
  assert.equal(prepared.id, initial.inventory_sha256)
  async function checkOwned(file) {
    const stat = await fs.lstat(file)
    assert.equal(stat.uid, 0, file); assert.equal(stat.gid, 0, file)
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      assert.equal(stat.mode & 0o005, 0o005, file)
      assert.equal(stat.mode & 0o022, 0, file)
      for (const name of await fs.readdir(file)) if (name !== 'cli.lock') await checkOwned(path.join(file, name))
    } else { assert.ok(stat.mode & 0o004, file); assert.equal(stat.mode & 0o022, 0, file) }
  }
  await checkOwned(install)
  await selectCliPayload(prepared)
  assert.equal(readCliSelection(install), prepared.id)
  await checkOwned(install)
  assert.equal((await prepareCliPayload({ sourceRoot: source, installRoot: install, scope: 'system' })).id, prepared.id)
  for (const [name, [contents, mode]] of Object.entries(files)) {
    assert.equal(await fs.readFile(path.join(source, name), 'utf8'), contents)
    const stat = await fs.lstat(path.join(source, name))
    assert.equal(stat.uid, builder.uid); assert.equal(stat.mode & 0o777, mode)
  }
  assert.equal((await fs.lstat(source)).mode & 0o777, 0o700)
  assert.equal((await fs.lstat(path.join(source, 'scripts/helper-link.mjs'))).uid, builder.uid)
  assert.equal((await verifyCoreRelease(source)).inventory_sha256, initial.inventory_sha256)
  const helper = path.join(prepared.coreRoot, 'scripts/system-user-helper.mjs')
  await fs.chown(helper, builder.uid, builder.gid)
  await assert.rejects(prepareCliPayload({ sourceRoot: source, installRoot: install, scope: 'system' }), /并非管理员所有/)
  await assert.rejects(selectCliPayload(prepared, { expected: prepared.id }), /并非管理员所有/)
  assert.equal((await fs.lstat(helper)).uid, builder.uid, 'an already published file must not be silently adopted')
  assert.equal(readCliSelection(install), prepared.id)
  await fs.chown(helper, 0, 0)
  await fs.chown(prepared.command, builder.uid, builder.gid)
  await assert.rejects(prepareCliPayload({ sourceRoot: source, installRoot: install, scope: 'system' }), /并非管理员所有/)
  assert.equal((await fs.lstat(prepared.command)).uid, builder.uid)
  const privateParent = path.join(root, 'private-existing')
  await fs.mkdir(privateParent, { mode: 0o700 })
  await assert.rejects(prepareCliPayload({ sourceRoot: source, installRoot: path.join(privateParent, 'install'), scope: 'system' }), /不可由员工访问/)
  assert.equal((await fs.lstat(privateParent)).mode & 0o777, 0o700)
  console.log('CRABOT_SYSTEM_INSTALL_OWNERSHIP ' + JSON.stringify({ copied_from_uid: builder.uid, root_owned: true, restrictive_umask: '077', source_preserved: true, untrusted_published_files_rejected: true }))
} finally {
  process.umask(previousMask)
  if (created) await fs.rm(root, { recursive: true, force: true })
}
