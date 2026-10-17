import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { openDesktopUpdate } from '../desktop-update-entry.mjs'

test('only a sealed app routes upgrade to its verified GUI executable with the fixed presentation argument', async t => {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), 'Crabot 更新 '))
  t.after(() => fs.rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'Crabot.app/Contents/Resources/core')
  await fs.mkdir(root, { recursive: true })
  let called = 0
  const launch = (exe, args, options) => {
    called++; assert.equal(exe, realpathSync(executable)); assert.deepEqual(args, ['--check-updates'])
    assert.equal(options.stdio, 'ignore'); assert.equal(options.detached, true)
    const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child
  }
  assert.equal(await openDesktopUpdate(root, { launch }), false); assert.equal(called, 0)
  const executable = process.platform === 'darwin' ? path.resolve(root, '../../MacOS/Crabot')
    : path.resolve(root, '../..', process.platform === 'win32' ? 'Crabot.exe' : 'crabot')
  await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.writeFile(executable, 'fixture-only')
  await fs.writeFile(path.join(root, 'desktop-host.json'), JSON.stringify({ schema_version: 1, platform: process.platform, arch: process.arch }))
  assert.equal(await openDesktopUpdate(root, { launch }), true); assert.equal(called, 1)
  await fs.writeFile(path.join(root, 'desktop-host.json'), '{}')
  await assert.rejects(openDesktopUpdate(root, { launch })); assert.equal(called, 1)
})
