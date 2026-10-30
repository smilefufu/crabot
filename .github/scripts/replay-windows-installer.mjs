// Replay an already-built candidate with current CI diagnostics. The sealed
// target Core/GUI is extracted unchanged; no new distributable is produced.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const execute = promisify(execFile), root = path.resolve('.desktop-build/manual')
const require = createRequire(path.resolve('crabot-desktop/package.json'))
const asar = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib/package.json'))('@electron/asar')
async function find(directory, suffix) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) { const match = await find(file, suffix); if (match) return match }
    else if (entry.name.endsWith(suffix)) return file
  }
}
const exe = await find(path.resolve(process.argv[2]), '-offline-candidate.exe')
assert.ok(exe)
const wrapper = path.join(root, 'wrapper'), host = path.join(root, 'host')
await execute('7z.exe', ['x', exe, '-o' + wrapper, '-y'], { timeout: 180000, maxBuffer: 1024 * 1024 })
const archive = await find(wrapper, 'app-64.7z'); assert.ok(archive)
await execute('7z.exe', ['x', archive, '-o' + host, '-y'], { timeout: 180000, maxBuffer: 1024 * 1024 })
const installer = path.join(root, 'installer'), paired = path.join(root, 'paired')
await fs.mkdir(installer); await fs.mkdir(paired)
asar.extractAll(path.join(host, 'resources/app.asar'), path.join(installer, 'app'))
await fs.cp('crabot-client', path.join(installer, 'crabot-client'), { recursive: true })
await fs.rename(path.join(host, 'resources/offline'), path.join(paired, 'offline'))
console.log('CRABOT_CI_REPLAY_PAYLOAD ' + JSON.stringify({ original_executable: path.basename(exe), target_unchanged: true }))
