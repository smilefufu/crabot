// Replay the exact completed EXE. Keep the first failure and its process facts;
// fixture cleanup must never replace the actual extraction error.
import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { verifyDesktopPrograms } from '../../scripts/lib/desktop-payload.mjs'
assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const execute = promisify(execFile), distribution = path.resolve('.desktop-build/manual/installer/distribution')
const files = (await fs.readdir(distribution)).filter(file => file.endsWith('offline-candidate.exe'))
assert.equal(files.length, 1)
const executable = path.join(distribution, files[0]), sums = await fs.readFile(path.join(distribution, 'SHA256SUMS'), 'utf8')
const digest = createHash('sha256'); for await (const bytes of createReadStream(executable)) digest.update(bytes)
assert.equal(sums.trim(), digest.digest('hex') + '  ' + files[0])
const root = await fs.mkdtemp(path.resolve('.desktop-build/actual-exe-recheck-')), reports = []
let selected
for (const maxBuffer of [65536, 16 * 1024 * 1024]) {
  const target = path.join(root, String(maxBuffer) + ' 中文 程序'), started = Date.now()
  const pending = execute(executable, ['/S', '/D=' + target], { windowsVerbatimArguments: true, timeout: 600000, maxBuffer })
  try {
    const result = await pending
    const inventories = await fs.readdir(path.join(target, 'app/installers')); assert.equal(inventories.length, 1)
    const record = JSON.parse(await fs.readFile(path.join(target, 'app/installers', inventories[0]), 'utf8'))
    const core = path.join(target, 'releases', record.selection.core_id), gui = path.join(target, 'app/releases', record.selection.gui_id)
    await verifyDesktopPrograms(core, gui, record)
    for (const name of ['data', 'current-release.json', 'desktop-installation.json']) await assert.rejects(fs.lstat(path.join(target, name)), { code: 'ENOENT' })
    reports.push({ maxBuffer, success: true, stdout_bytes: Buffer.byteLength(result.stdout), stderr_bytes: Buffer.byteLength(result.stderr), elapsed_ms: Date.now() - started })
    selected = { target, record, core, gui }
  } catch (error) {
    reports.push({ maxBuffer, success: false, code: error.code, signal: error.signal, killed: error.killed, installer_pid: pending.child?.pid,
      message: error.message, stdout_tail: String(error.stdout ?? '').slice(-1500), stderr_tail: String(error.stderr ?? '').slice(-1500), elapsed_ms: Date.now() - started })
  }
  console.log('CRABOT_EXACT_EXE_RECHECK ' + JSON.stringify(reports.at(-1)))
  await fs.writeFile('.desktop-build/exact-exe-recheck.json', JSON.stringify(reports) + '\n')
}
assert.ok(selected, 'The exact EXE did not finish with a complete program inventory')
// A read-only reference payload for the existing official-CLI acceptance. Move
// these test files, rather than making another complete runtime copy.
const payload = path.resolve('.desktop-build/manual/paired/offline')
await fs.mkdir(payload, { recursive: true })
await fs.rename(selected.core, path.join(payload, 'core')); await fs.rename(selected.gui, path.join(payload, 'gui'))
await fs.writeFile(path.join(payload, 'desktop-payload.json'), JSON.stringify(selected.record) + '\n')
console.log('CRABOT_EXACT_EXE_REFERENCE_READY ' + JSON.stringify({ selected_programs_verified: true, actual_exe_unchanged: true, data_initialized: false }))
