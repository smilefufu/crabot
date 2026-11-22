import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { prepareUpgrade, installPreparedUpgrade } from '../prepared-upgrade.mjs'
import { preflightRestart } from '../preflight.mjs'
import { acquireCliLock, releaseCliLock } from '../../lib/cli-lock.mjs'
import { fileURLToPath } from 'node:url'
import nativeBuild from '../../lib/native-build.cjs'
const product = fileURLToPath(new URL('../../../', import.meta.url))
let root, home, data
const git = args => execFileSync('git', args, { cwd: home, stdio: 'pipe' })
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'prepared-upgrade-'))
  home = path.join(root, 'product'); data = path.join(root, 'data')
  await fs.mkdir(home); await fs.mkdir(data)
  await fs.writeFile(path.join(home, 'package.json'), '{}')
  await fs.writeFile(path.join(home, '.gitignore'), 'dist/\nnode_modules/\ndata/\n.env\n')
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
  await fs.mkdir(path.join(home, 'dist')); await fs.writeFile(path.join(home, 'dist/live.js'), 'old build')
  await fs.writeFile(path.join(home, '.env'), 'PRIVATE CONFIG')
})
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })
async function build(stage) {
  await fs.mkdir(path.join(stage, 'dist')); await fs.writeFile(path.join(stage, 'dist/live.js'), 'new build')
}
const options = extra => ({ mode: 'source', build, verify: async () => {}, audit: async () => {}, ...extra })
it('online preparation and reuse preserve the live build, secrets and running instance; build happens once', async () => {
  await fs.writeFile(path.join(data, 'mm.pid'), String(process.pid))
  const builder = vi.fn(build)
  const a = await prepareUpgrade(home, data, options({ build: builder }))
  const b = await prepareUpgrade(home, data, options({ build: builder }))
  expect(b.reused).toBe(true); expect(builder).toHaveBeenCalledTimes(1)
  expect(a.identity.target).toBe(git(['rev-parse', 'HEAD']).toString().trim())
  expect(await fs.readFile(path.join(home, 'dist/live.js'), 'utf8')).toBe('old build')
  expect(await fs.readFile(path.join(home, '.env'), 'utf8')).toBe('PRIVATE CONFIG')
  expect(await fs.readFile(path.join(data, 'mm.pid'), 'utf8')).toBe(String(process.pid))
  await expect(fs.stat(path.join(a.stage, '.env'))).rejects.toThrow()
  await expect(fs.stat(path.join(a.stage, 'data'))).rejects.toThrow()
  await expect(installPreparedUpgrade(a, home, data)).rejects.toThrow('Stop Crabot')
})
it('dirty source, build failure and unknown migration scope fail without altering installed code', async () => {
  await fs.writeFile(path.join(home, 'package.json'), '{"changed":true}')
  const builder = vi.fn(build)
  await expect(prepareUpgrade(home, data, options({ build: builder }))).rejects.toThrow('uncommitted')
  expect(builder).not.toHaveBeenCalled()
  await fs.writeFile(path.join(home, 'package.json'), '{}')
  await expect(prepareUpgrade(home, data, options({ build: async () => { throw new Error('build failure') } }))).rejects.toThrow('build failure')
  await expect(prepareUpgrade(home, data, options({ build: async stage => {
    await build(stage); await fs.mkdir(path.join(stage, 'crabot-test')); await fs.writeFile(path.join(stage, 'crabot-test/schema_version'), 'v2')
    await fs.mkdir(path.join(data, 'test')); await fs.writeFile(path.join(data, 'test/SCHEMA_VERSION'), 'v1')
  } }))).rejects.toThrow('Missing migration scope')
  expect(await fs.readFile(path.join(home, 'dist/live.js'), 'utf8')).toBe('old build')
})
it('stale payload is rejected and cannot silently become a reused success', async () => {
  const a = await prepareUpgrade(home, data, options())
  await fs.writeFile(path.join(a.stage, 'dist/live.js'), 'tampered')
  await expect(prepareUpgrade(home, data, options())).rejects.toThrow('Prepared product changed')
  expect(await fs.readFile(path.join(home, 'dist/live.js'), 'utf8')).toBe('old build')
})
it('switch only moves prepared artifacts, preserving .git and private files; old artifacts remain recoverable', async () => {
  const prepared = await prepareUpgrade(home, data, options())
  const revision = git(['rev-parse', 'HEAD']).toString()
  const lock = await acquireCliLock(data, 'upgrade')
  try {
    const installed = await installPreparedUpgrade(prepared, home, data)
    expect(await fs.readFile(path.join(home, 'dist/live.js'), 'utf8')).toBe('new build')
    expect(await fs.readFile(path.join(installed.rollback, 'dist/live.js'), 'utf8')).toBe('old build')
    expect(await fs.readFile(path.join(home, '.env'), 'utf8')).toBe('PRIVATE CONFIG')
    expect(git(['rev-parse', 'HEAD']).toString()).toBe(revision)
    expect(git(['status', '--porcelain']).toString()).toBe('')
  } finally { releaseCliLock(lock) }
})
it('switch IO failure restores only moved product artifacts and keeps business data', async () => {
  const prepared = await prepareUpgrade(home, data, options())
  await fs.writeFile(path.join(data, 'business'), 'keep')
  const rename = fs.rename
  vi.spyOn(fs, 'rename').mockImplementation((from, to) => String(from) === path.join(prepared.stage, 'dist') ? Promise.reject(new Error('switch failure')) : rename(from, to))
  const lock = await acquireCliLock(data, 'upgrade')
  try { await expect(installPreparedUpgrade(prepared, home, data)).rejects.toThrow('switch failure') }
  finally { releaseCliLock(lock) }
  expect(await fs.readFile(path.join(home, 'dist/live.js'), 'utf8')).toBe('old build')
  expect(await fs.readFile(path.join(data, 'business'), 'utf8')).toBe('keep')
})
it('release extraction, dependency preparation and integrity failures all happen before any installed file changes', async () => {
  const releaseHome = path.join(root, 'release'); await fs.mkdir(releaseHome); await fs.writeFile(path.join(releaseHome, 'live'), 'old release')
  const order = []
  const download = async () => { order.push('download'); const tmp = await fs.mkdtemp(path.join(root, 'download-')); return { tmp, tarPath: path.join(tmp, 'archive'), version: 'next' } }
  const unpack = async ({ stage }) => { order.push('unpack'); await fs.writeFile(path.join(stage, 'live'), 'new release'); return stage }
  await expect(prepareUpgrade(releaseHome, data, { mode: 'release', version: 'next', download, unpack,
    sync: async () => { order.push('dependencies'); throw new Error('dependency failure') }, verify: vi.fn(), audit: vi.fn() })).rejects.toThrow('dependency failure')
  expect(order).toEqual(['download', 'unpack', 'dependencies'])
  expect(await fs.readFile(path.join(releaseHome, 'live'), 'utf8')).toBe('old release')
})
it('restart preflight refuses missing artifacts and unknown adapters while a live PID remains unchanged', async () => {
  await fs.writeFile(path.join(data, 'mm.pid'), String(process.pid))
  await expect(preflightRestart(home, data)).rejects.toThrow()
  for (const name of ['crabot-core/dist/main.js', 'crabot-core/dist/orphan-recovery-preflight.js', 'crabot-admin/dist/main.js', 'crabot-agent/dist/main.js', 'scripts/prepare-shared-requests.mjs']) {
    await fs.mkdir(path.dirname(path.join(home, name)), { recursive: true }); await fs.writeFile(path.join(home, name), '// fixture')
  }
  await fs.writeFile(path.join(home, 'crabot-core/schema_version'), 'v2')
  await fs.mkdir(path.join(data, 'core')); await fs.writeFile(path.join(data, 'core/SCHEMA_VERSION'), 'v1')
  await expect(preflightRestart(home, data)).rejects.toThrow('Missing migration scope')
  expect(await fs.readFile(path.join(data, 'mm.pid'), 'utf8')).toBe(String(process.pid))
})

async function nativeSource() {
  await fs.cp(path.join(product, 'crabot-native/src'), path.join(home, 'crabot-native/src'), { recursive: true })
  for (const name of ['scripts/build-native.mjs', 'scripts/lib/native-build.cjs', 'scripts/lib/native-probe.cjs']) {
    await fs.mkdir(path.dirname(path.join(home, name)), { recursive: true })
    await fs.copyFile(path.join(product, name), path.join(home, name))
  }
  await fs.appendFile(path.join(home, '.gitignore'), 'crabot-native/build/\n.desktop-build/\n')
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'native inputs'])
}
async function nativeTarget(stage) {
  await build(stage)
  await fs.cp(nativeBuild.standardDirectory(product), nativeBuild.standardDirectory(stage), { recursive: true })
}
it('native source target must be complete, is switched and retained for rollback with its verified receipt', async () => {
  await nativeSource()
  await expect(prepareUpgrade(home, data, options())).rejects.toThrow('原生产物缺失')
  await fs.cp(nativeBuild.standardDirectory(product), nativeBuild.standardDirectory(home), { recursive: true })
  const prepared = await prepareUpgrade(home, data, options({ build: nativeTarget }))
  expect(prepared.artifacts).toContain('crabot-native/build/Release')
  expect(prepared.entries.some(entry => entry.name.endsWith('native-build.json'))).toBe(true)
  const lock = await acquireCliLock(data, 'upgrade')
  try {
    const installed = await installPreparedUpgrade(prepared, home, data)
    expect(nativeBuild.nativeReady(home, nativeBuild.standardDirectory(home))).toBe(true)
    expect(await fs.readFile(path.join(installed.rollback, 'crabot-native/build/Release/native-build.json'), 'utf8'))
      .toBe(await fs.readFile(path.join(home, 'crabot-native/build/Release/native-build.json'), 'utf8'))
  } finally { releaseCliLock(lock) }
}, 30000)
it('old prepared success missing the native artifact is rebuilt rather than reused', async () => {
  await nativeSource()
  const prepared = await prepareUpgrade(home, data, options({ build: nativeTarget }))
  const readyFile = path.join(path.dirname(prepared.stage), 'prepared.json')
  const old = JSON.parse(await fs.readFile(readyFile, 'utf8'))
  old.artifacts = old.artifacts.filter(name => name !== 'crabot-native/build/Release')
  await fs.writeFile(readyFile, JSON.stringify(old))
  const builder = vi.fn(nativeTarget)
  const repaired = await prepareUpgrade(home, data, options({ build: builder }))
  expect(repaired.reused).toBe(false); expect(builder).toHaveBeenCalledTimes(1)
  expect(repaired.artifacts).toContain('crabot-native/build/Release')
}, 30000)
it('post-switch native load failure rolls back native files and ordinary product artifacts', async () => {
  await nativeSource()
  await fs.cp(nativeBuild.standardDirectory(product), nativeBuild.standardDirectory(home), { recursive: true })
  const old = await fs.readFile(path.join(home, 'crabot-native/build/Release/crabot-native.node'))
  const prepared = await prepareUpgrade(home, data, options({ build: nativeTarget }))
  const rename = fs.rename
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to)
    if (String(from) === path.join(prepared.stage, 'crabot-native/build/Release')) {
      await fs.appendFile(path.join(to, 'crabot-native.node'), 'injected switch corruption')
    }
  })
  const lock = await acquireCliLock(data, 'upgrade')
  try { await expect(installPreparedUpgrade(prepared, home, data)).rejects.toThrow('损坏') }
  finally { releaseCliLock(lock) }
  expect(await fs.readFile(path.join(home, 'crabot-native/build/Release/crabot-native.node'))).toEqual(old)
  expect(await fs.readFile(path.join(home, 'dist/live.js'), 'utf8')).toBe('old build')
}, 30000)
