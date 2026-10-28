import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
for (const kind of ['installation', 'removal']) test('actual ' + kind + ' Chromium exposes only controlled cancellation and refuses a foreign window', { timeout: 40_000 }, async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-installer-progress-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const env = { ...process.env, CRABOT_INSTALL_PROGRESS_ROOT: root, CRABOT_INSTALL_PROGRESS_KIND: kind }; delete env.ELECTRON_RUN_AS_NODE
  const result = await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('./installer-progress.cjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
    let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, output }))
  })
  assert.equal(result.code, 0, result.output)
  const marker = kind === 'removal' ? 'CRABOT_REMOVAL_PROGRESS ' : 'CRABOT_INSTALLER_PROGRESS '
  const record = result.output.split('\n').find(line => line.startsWith(marker))
  assert.ok(record, result.output); assert.equal(JSON.parse(record.slice(marker.length)).business_mm_started, false)
  const output = fileURLToPath(new URL('../../.desktop-build/' + (kind === 'removal' ? 'removal-progress.png' : 'installer-progress.png'), import.meta.url))
  await fs.copyFile(path.join(root, 'progress.png'), output)
  console.log(record)
})
