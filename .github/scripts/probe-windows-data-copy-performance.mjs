// Bounded, disposable copy-only comparison. No installation, migration or service work.
import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

assert.equal(process.platform, 'win32')
assert.equal(process.versions.node.split('.')[0], '22')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const execute = promisify(execFile), repository = fileURLToPath(new URL('../../', import.meta.url))
const baselineRevision = '059eaf466ebd4bef2f338a716d32ad53ebcfe5e7', budget = 200000000
const report = value => console.log('CRABOT_WINDOWS_DATA_COPY_PERFORMANCE ' + JSON.stringify(value))

if (process.argv[2] !== '--worker') {
  assert.equal(process.argv.length, 2)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-data-copy-performance-'))
  const deadline = setTimeout(() => { report({ stage: 'timeout', fixture_cleaned: false }); process.exit(1) }, 600000)
  deadline.unref()
  try {
    const space = await fs.statfs(root), available = Number(space.bavail) * Number(space.bsize)
    assert.ok(available >= budget, 'The disposable performance fixture needs 200 MB free; no user data is touched')
    // The parent remains responsive even if a synchronous Windows ACL/flush call stalls.
    const result = await execute(process.execPath, [fileURLToPath(import.meta.url), '--worker', root], {
      cwd: repository, timeout: 540000, maxBuffer: 1024 * 1024, windowsHide: true,
    })
    process.stdout.write(result.stdout); process.stderr.write(result.stderr)
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout)
    if (error.stderr) process.stderr.write(error.stderr)
    throw error
  } finally {
    try { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
    finally { clearTimeout(deadline) }
  }
} else {
  const root = await fs.realpath(process.argv[3])
  assert.equal(path.dirname(root).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase())
  assert.ok(path.basename(root).startsWith('crabot-data-copy-performance-'))
  assert.deepEqual(await fs.readdir(root), [])
  const { default: identity } = await import('../../scripts/lib/process-identity.cjs')
  const { default: management } = await import('../../scripts/lib/desktop-management.cjs')
  const { copyDesktopData } = await import('../../scripts/lib/desktop-data-import.mjs')
  const { assertWorkspaceDataCompatibility } = await import('../../scripts/lib/workspace-data-compat.mjs')
  let baseline, baselineError
  try {
    const { stdout } = await execute('git', ['show', baselineRevision + ':scripts/lib/desktop-data-import.mjs'], { cwd: repository, timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true })
    const start = stdout.indexOf('export async function copyDesktopData('), end = stdout.indexOf('\nasync function prepareImportedData(', start)
    const helpers = stdout.split('\n').filter(line => line.startsWith('const within = ') || line.startsWith('async function present('))
    assert.ok(start >= 0 && end > start && helpers.length === 2, 'Pinned baseline copy function boundaries changed')
    // This exact operation only copies stopped data; inject its original filesystem
    // helpers and real native ACL implementation, never a takeover/maintenance runner.
    baseline = new Function('fs', 'constants', 'path', 'identity', 'management', helpers.join('\n') + '\nreturn (' + stdout.slice(start, end).replace(/^export /, '') + ')')(fs, constants, path, identity, management)
  } catch (error) { baselineError = error.code === 'ENOENT' ? 'git_unavailable' : 'pinned_baseline_unavailable_or_unrecognized' }
  report({ stage: 'configuration', node: process.version, baseline_revision: baselineRevision, baseline_available: Boolean(baseline),
    ...(baselineError ? { baseline_unavailable: baselineError } : {}), budget_bytes: budget, timeout_ms: 600000,
    measurement: 'copyDesktopData only; real native ACL and flush; validation outside timing; OS caches warmed by source validation' })

  async function pool(values, visit) {
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(8, values.length) }, async () => { while (cursor < values.length) await visit(values[cursor++]) }))
  }
  async function snapshot(directory) {
    const entries = []
    async function visit(name) {
      const file = path.join(directory, name), info = await fs.lstat(file)
      assert.ok(info.isFile() || info.isDirectory(), 'The generated fixture contains only regular files and directories')
      const entry = { name, type: info.isFile() ? 'file' : 'directory', mode: info.mode & 0o777, mtime_ms: info.mtimeMs,
        private: info.isFile() ? identity.isPrivateFile(file) : identity.isPrivateDirectory(file) }
      if (info.isFile()) { entry.size = info.size; entry.sha256 = createHash('sha256').update(await fs.readFile(file)).digest('hex') }
      entries.push(entry)
      if (info.isDirectory()) await pool(await fs.readdir(file), child => visit(path.join(name, child)))
    }
    await visit('.')
    return entries.sort((a, b) => a.name.localeCompare(b.name))
  }
  const copiedFacts = entries => entries.map(({ mtime_ms, ...entry }) => entry)
  const results = []
  for (const fixture of [{ kind: 'small-files', files: 10000, size: 4096 }, { kind: 'large-files', files: 4, size: 10240000 }]) {
    const source = path.join(root, 'source'), destination = path.join(root, 'target')
    management.ensurePrivateDataRoot(source)
    await fs.mkdir(path.join(source, 'payload'))
    if (fixture.kind === 'small-files') for (let bucket = 0; bucket < 100; bucket++) await fs.mkdir(path.join(source, 'payload', String(bucket)))
    await pool(Array.from({ length: fixture.files }, (_, index) => index), async index => {
      const name = fixture.kind === 'small-files' ? path.join(String(Math.floor(index / 100)), String(index)) : String(index)
      const file = path.join(source, 'payload', name), text = String(index).padEnd(Math.min(fixture.size, 4096), 'x')
      if (index % 4 === 0) identity.writePrivateFile(file, fixture.size === 4096 ? text : '')
      if (index % 4 !== 0 || fixture.size !== 4096) {
        const bytes = Buffer.alloc(fixture.size, 'x'); bytes.write(String(index))
        await fs.writeFile(file, bytes)
      }
    })
    const control = management.ensurePrivateDataRoot(path.join(source, 'workspace-control'))
    identity.writePrivateFile(path.join(control, 'catalog.json'), JSON.stringify({ version: 1, revision: 1, storage_root: path.join(source, 'workspaces'), workspaces: [] }) + '\n')
    await fs.mkdir(path.join(source, 'admin'))
    identity.writePrivateFile(path.join(source, 'admin/credentials.json'), '{"probe":"private-credential-sentinel"}\n')
    const original = await snapshot(source), files = original.filter(entry => entry.type === 'file')
    const bytes = files.reduce((sum, entry) => sum + entry.size, 0), privateFiles = files.filter(entry => entry.private).length
    assert.equal(files.length, fixture.files + 2)
    assert.equal(privateFiles, fixture.files / 4 + 2)
    assert.ok(bytes * 2 < budget, 'One source and one target at a time must stay within the fixture budget')
    for (let repeat = 0; repeat < 2; repeat++) {
      const methods = baseline ? (repeat === 0 ? [['baseline', baseline], ['current', copyDesktopData]] : [['current', copyDesktopData], ['baseline', baseline]]) : [['current', copyDesktopData]]
      for (const [method, copy] of methods) {
        let progressEvents = 0
        const started = performance.now(), copied = await copy(source, destination, { progress: () => { progressEvents++ } })
        const elapsed = performance.now() - started
        assert.deepEqual(copied, { files: files.length, bytes })
        assert.deepEqual(copiedFacts(await snapshot(destination)), copiedFacts(original), 'Copied file bytes, modes and private ACL classifications must match the same source')
        management.requirePrivateDataRoot(path.join(destination, 'workspace-control'))
        assert.equal(identity.isPrivateFile(path.join(destination, 'workspace-control/catalog.json')), true)
        assert.equal(identity.isPrivateFile(path.join(destination, 'admin/credentials.json')), true)
        assertWorkspaceDataCompatibility(repository, destination)
        assert.deepEqual(await snapshot(source), original, 'Copying must not mutate the source contents or write metadata')
        const result = { stage: 'result', kind: fixture.kind, method, repeat, files: copied.files, bytes: copied.bytes, payload_files: fixture.files,
          payload_bytes: fixture.files * fixture.size, payload_private_ratio: 0.25, private_files: privateFiles, private_file_ratio: privateFiles / files.length,
          elapsed_ms: Math.round(elapsed), progress_events: progressEvents, contents_and_acl_verified: true, source_unchanged: true }
        results.push(result); report(result)
        await fs.rm(destination, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    }
    await fs.rm(source, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  report({ stage: 'complete', comparisons: results.length, baseline_available: Boolean(baseline), fixture_cleaned: true, windows_user_history_tested: false })
}
