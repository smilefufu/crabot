// Actual native mkdir contract on a disposable Windows runner. No service starts.
import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import identity from '../../scripts/lib/process-identity.cjs'
assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const execute = promisify(execFile), helper = path.resolve('crabot-native/build/Release/crabot-install-directory.exe')
await fs.mkdir('.desktop-build', { recursive: true })
const root = await fs.mkdtemp(path.resolve('.desktop-build/install-directory-'))
const run = target => execute(helper, [target], { timeout: 10000 })
try {
  const direct = path.join(path.parse(root).root, 'Crabot-directory-proof-' + path.basename(root))
  await assert.rejects(fs.lstat(direct), { code: 'ENOENT' })
  await fs.mkdir(direct); await fs.rmdir(direct) // Ordinary creation works with this same user and path.
  try { await run(direct); assert.equal(identity.isPrivateDirectory(direct), true) }
  finally { await fs.rm(direct, { recursive: true, force: true }) }
  const nested = path.join(path.parse(root).root, 'Crabot-nested-proof-' + path.basename(root), 'missing parent', '程序')
  try { await run(nested); assert.equal(identity.isPrivateDirectory(nested), true) }
  finally { await fs.rm(path.dirname(path.dirname(nested)), { recursive: true, force: true }) }
  const inherited = path.join(root, 'old plain mkdir'); await fs.mkdir(inherited)
  const previous = { owned: identity.isOwnedDirectory(inherited), data_acl: identity.isExistingDataDirectory(inherited) }
  const selected = path.join(root, '中文 程序'); await run(selected)
  assert.equal(identity.isPrivateDirectory(selected), true)
  assert.equal(identity.isExistingDataDirectory(selected), true)
  const empty = path.join(root, 'selected empty'); identity.createPrivateDirectory(empty); await run(empty)
  assert.equal(identity.isPrivateDirectory(empty), true)
  const administrators = path.join(root, 'administrator-owned writable empty')
  identity.createPrivateDirectory(administrators)
  await execute(path.join(process.env.SystemRoot, 'System32/icacls.exe'), [administrators, '/setowner', '*S-1-5-32-544'], { timeout: 10000 })
  assert.equal(identity.isOwnedDirectory(administrators), true, 'current user can manage this directory under the existing product rule')
  await run(administrators)
  assert.equal(identity.isPrivateDirectory(administrators), true)
  await fs.writeFile(path.join(administrators, 'keep.txt'), 'keep existing ACL and contents')
  await execute(path.join(process.env.SystemRoot, 'System32/icacls.exe'), [administrators, '/setowner', '*S-1-5-32-544'], { timeout: 10000 })
  const administratorBefore = await fs.stat(administrators, { bigint: true })
  await run(administrators)
  assert.equal((await fs.stat(administrators, { bigint: true })).ino, administratorBefore.ino)
  assert.equal(await fs.readFile(path.join(administrators, 'keep.txt'), 'utf8'), 'keep existing ACL and contents')
  await fs.writeFile(path.join(selected, 'preserve.txt'), 'existing installation and data stay')
  const before = await fs.stat(selected, { bigint: true })
  await run(selected)
  const after = await fs.stat(selected, { bigint: true })
  assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev)
  assert.equal(identity.isPrivateDirectory(selected), true)
  assert.equal(await fs.readFile(path.join(selected, 'preserve.txt'), 'utf8'), 'existing installation and data stay')
  const junction = path.join(root, 'redirected'); await fs.symlink(selected, junction, 'junction')
  await assert.rejects(run(junction))
  const file = path.join(root, 'ordinary-file'); await fs.writeFile(file, 'never overwrite')
  await assert.rejects(run(file)); assert.equal(await fs.readFile(file, 'utf8'), 'never overwrite')
  await assert.rejects(run(path.parse(root).root))
  console.log('CRABOT_INSTALL_DIRECTORY ' + JSON.stringify({ previous_plain_mkdir: previous, new_selected_private: true,
    selected_empty_private: true, absent_drive_root_child_created: true, missing_nested_parents_created: true, administrators_owned_empty_accepted: true, nonempty_identity_and_contents_preserved: true, redirection_and_file_rejected: true }))
} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
