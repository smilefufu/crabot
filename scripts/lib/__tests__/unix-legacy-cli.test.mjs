import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { forwardImportedUnixCommand } from '../unix-legacy-cli.mjs'

for (const target of ['release', 'source', 'custom']) test('explicit import forwards only the verified ' + target + ' command', { skip: process.platform === 'win32' }, async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-unix-entry-')))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const sourceRoot = path.join(home, '.crabot'), coreRoot = path.join(home, 'Core'), prefix = path.join(home, '.local/bin')
  for (const directory of [sourceRoot, coreRoot, prefix]) await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  if (target === 'source') await fs.mkdir(path.join(sourceRoot, '.git'))
  const original = target === 'custom' ? path.join(home, 'other/cli.mjs') : path.join(sourceRoot, 'cli.mjs')
  await fs.symlink(original, path.join(prefix, 'crabot'))
  const options = { home, sourceRoot, coreRoot }
  assert.equal(await forwardImportedUnixCommand(options), target === 'release')
  assert.equal(await fs.readlink(path.join(prefix, 'crabot')), target === 'release' ? path.join(coreRoot, 'bin/crabot') : original)
  assert.equal(await forwardImportedUnixCommand(options), target === 'release')
})
