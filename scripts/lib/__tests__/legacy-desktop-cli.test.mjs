import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { adoptLegacyDesktopCli } from '../legacy-desktop-cli.mjs'
async function fixture(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot 旧命令 ')))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const root = path.join(home, '.crabot'), directory = path.join(home, '.local/bin'), entry = path.join(directory, 'crabot')
  await fs.mkdir(path.join(root, 'bin'), { recursive: true }); await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(root, 'cli.mjs'), '#!/usr/bin/env node\nthrow Error("old entry")\n')
  await fs.writeFile(path.join(root, 'bin/crabot'), '#!/bin/sh\nprintf "%s\\n" "$1"\n', { mode: 0o755 })
  return { home, root, directory, entry, metadata: path.join(directory, '.crabot-desktop-cli.json') }
}
const posix = { skip: process.platform === 'win32' }
for (const relative of [false, true]) test('takeover standard link uses native launcher without host Node and retries: relative=' + relative, posix, async t => {
  const f = await fixture(t), original = path.join(f.root, 'cli.mjs')
  await fs.symlink(relative ? path.relative(f.directory, original) : original, f.entry)
  assert.equal(await adoptLegacyDesktopCli({ installRoot: f.root, home: f.home }), true)
  assert.equal(await adoptLegacyDesktopCli({ installRoot: f.root, home: f.home }), true)
  assert.equal(await fs.readlink(f.entry), path.join(f.root, 'bin/crabot'))
  assert.deepEqual(JSON.parse(await fs.readFile(f.metadata, 'utf8')), { schema_version: 2, install_root: f.root })
  const output = await promisify(execFile)(f.entry, ['status'], { env: { HOME: f.home, PATH: '/no-host-node' } })
  assert.equal(output.stdout, 'status\n'); assert.match(await fs.readFile(original, 'utf8'), /old entry/)
})
for (const kind of ['missing', 'custom-file', 'custom-link', 'shared-prefix']) test('takeover preserves unmanaged command: ' + kind, posix, async t => {
  const f = await fixture(t)
  if (kind === 'custom-file') await fs.writeFile(f.entry, 'custom command')
  if (kind === 'custom-link') await fs.symlink('/other/cli.mjs', f.entry)
  if (kind === 'shared-prefix') { await fs.symlink(path.join(f.root, 'cli.mjs'), f.entry); await fs.chmod(f.directory, 0o777) }
  assert.equal(await adoptLegacyDesktopCli({ installRoot: f.root, home: f.home }), false)
  if (kind === 'custom-file') assert.equal(await fs.readFile(f.entry, 'utf8'), 'custom command')
  if (kind === 'custom-link') assert.equal(await fs.readlink(f.entry), '/other/cli.mjs')
  if (kind === 'shared-prefix') assert.equal(await fs.readlink(f.entry), path.join(f.root, 'cli.mjs'))
  await assert.rejects(fs.stat(f.metadata), { code: 'ENOENT' })
})
test('an interrupted standard-link replacement reuses existing metadata without overwriting custom changes', posix, async t => {
  const f = await fixture(t), original = path.join(f.root, 'cli.mjs')
  await fs.symlink(original, f.entry)
  const rename = t.mock.method(fs, 'rename', async () => { throw new Error('controlled rename interruption') })
  await assert.rejects(adoptLegacyDesktopCli({ installRoot: f.root, home: f.home }), /controlled rename interruption/); rename.mock.restore()
  assert.equal(await fs.readlink(f.entry), original)
  assert.equal(await adoptLegacyDesktopCli({ installRoot: f.root, home: f.home }), true)
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['.crabot-desktop-cli.json', 'crabot'])
})
