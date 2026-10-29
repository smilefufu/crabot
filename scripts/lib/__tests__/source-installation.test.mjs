import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverUserSourceDeployment } from '../source-installation.mjs'
import { assertFreshUserInstallation } from '../legacy-desktop.mjs'

test('historical source command and data remain intact while a separate release is allowed', { skip: process.platform === 'win32' }, async t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'crabot-source-coexist-'))), sourceRoot = join(home, 'source')
  t.after(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(join(sourceRoot, '.git'), { recursive: true }); mkdirSync(join(home, '.local/bin'), { recursive: true }); mkdirSync(join(home, '.crabot/data'), { recursive: true })
  writeFileSync(join(sourceRoot, 'cli.mjs'), 'source entry'); writeFileSync(join(sourceRoot, 'package.json'), '{"name":"crabot"}')
  writeFileSync(join(home, '.crabot/data/history'), 'retain source history')
  symlinkSync(join(sourceRoot, 'cli.mjs'), join(home, '.local/bin/crabot'))
  const options = { home, source: { PATH: '' } }
  assert.equal(discoverUserSourceDeployment(options).root, sourceRoot)
  await assertFreshUserInstallation(options)
  assert.equal(readFileSync(join(home, '.local/bin/crabot'), 'utf8'), 'source entry')
  assert.equal(readFileSync(join(home, '.crabot/data/history'), 'utf8'), 'retain source history')
})
test('an arbitrary Git checkout is not evidence for bypassing unknown old deployment handling', async t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'crabot-unknown-source-')))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(join(home, '.crabot/.git'), { recursive: true }); mkdirSync(join(home, '.crabot/data'))
  writeFileSync(join(home, '.crabot/cli.mjs'), 'unknown'); writeFileSync(join(home, '.crabot/package.json'), '{"name":"different-project"}')
  assert.equal(discoverUserSourceDeployment({ home, source: { PATH: '' } }), null)
  await assert.rejects(assertFreshUserInstallation({ home, source: { PATH: '' } }), { code: 'CRABOT_DESKTOP_TAKEOVER_REQUIRED' })
})
