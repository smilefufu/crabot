import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { attachLocalPages } from '../dist/local-pages.js'

for (const route of ['/workspaces', '/workspaces?relocation_id=ed083bf7-54c4-4296-98d7-c8e87ca05e40']) {
  test('desktop reload serves the workspace route: ' + route, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'crabot-local-workspace-page-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    await writeFile(path.join(directory, 'desktop.html'), '<main>workspace application</main>')
    let handle
    attachLocalPages({ protocol: { handle(scheme, listener) { assert.equal(scheme, 'app'); handle = listener } } }, directory)
    const response = await handle(new Request('app://crabot' + route))
    assert.equal(response.status, 200)
    assert.match(response.headers.get('Content-Type'), /^text\/html/)
    assert.equal(await response.text(), '<main>workspace application</main>')
  })
}
