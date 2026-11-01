import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('the actual sandboxed startup renderer cancels copy, blocks migration cancellation and retries in one normal window', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-startup-page-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const env = { ...process.env, CRABOT_STARTUP_PAGE_TEST_ROOT: root }
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
  const { stdout } = await promisify(execFile)(createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('startup-page.cjs', import.meta.url))], { env, timeout: 20000, maxBuffer: 65536 })
  const line = stdout.split('\n').find(line => line.startsWith('CRABOT_STARTUP_PAGE '))
  assert.ok(line, stdout)
  assert.deepEqual(JSON.parse(line.slice('CRABOT_STARTUP_PAGE '.length)), { actual_sandboxed_renderer: true, copy_cancel: true, migration_cancel_blocked: true, concrete_error: true, retry: true, one_window: true, business_mm_started: false })
})
