import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
for (const alias of [false, true]) test('archive output cannot mutate its source through ' + (alias ? 'a redirected parent' : 'a nested destination'), async t => {
  const parent = await fs.mkdtemp(path.join(repository, '.desktop-build/archive-boundary-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const core = path.join(parent, 'core'); await fs.mkdir(core)
  await fs.writeFile(path.join(core, 'marker'), 'immutable source')
  let destination = path.join(core, 'archive')
  if (alias) {
    const link = path.join(parent, 'redirect')
    await fs.symlink(core, link, process.platform === 'win32' ? 'junction' : 'dir')
    destination = path.join(link, 'archive')
  }
  await assert.rejects(promisify(execFile)(process.execPath, [path.join(repository, 'scripts/desktop/archive-core.mjs'),
    '--candidate=true', '--core=' + core, '--out=' + destination]), error => {
    assert.match(error.stderr, /output cannot be inside the Core/)
    return true
  })
  assert.deepEqual(await fs.readdir(core), ['marker'])
  assert.equal(await fs.readFile(path.join(core, 'marker'), 'utf8'), 'immutable source')
})
