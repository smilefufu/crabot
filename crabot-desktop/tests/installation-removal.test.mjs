import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('actual Electron removes only entries in the private fixture and keeps data and programs', { timeout: 35_000 }, async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'Crabot 入口移除 '))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const env = { ...process.env }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV']) delete env[name]
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'),
    [fileURLToPath(new URL('./installation-removal.cjs', import.meta.url)), root], { env, timeout: 30000, maxBuffer: 32768 })
  assert.match(result.stdout, /"owned_entries_removed":true/)
  const job = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('CRABOT_REMOVAL_MENU_JOB ')).slice('CRABOT_REMOVAL_MENU_JOB '.length))
  assert.equal(job.core_missing, true); assert.equal(job.owned_menu_removed, true); assert.equal(job.discovery_preserved, true)
  assert.equal(job.actual_windows_shortcut, process.platform === 'win32')
  const final = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('CRABOT_REMOVAL_INSTALLATION_ENTRIES ')).slice('CRABOT_REMOVAL_INSTALLATION_ENTRIES '.length))
  assert.equal(final.discovery_removed, true); assert.equal(final.foreign_locator_preserved, true)
  assert.equal(final.removal_fence_preserved, true); assert.equal(final.data_preserved, true); assert.equal(final.complete_uninstall_tested, false)
  console.log(result.stdout.trim())
})
