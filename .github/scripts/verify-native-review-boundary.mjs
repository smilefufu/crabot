// Review-boundary proof: current main plus only the candidate native foundation.
// No product install, business MM, user profile or existing checkout is changed.
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
const repository = process.cwd(), base = process.argv[2]
if (process.argv.length !== 3 || !/^[a-f0-9]{40}$/.test(base ?? '')) throw new Error('Provide the exact main/base commit')
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const temporary = await fs.mkdtemp(path.join(tmpdir(), 'crabot-native-base-review-'))
const target = path.join(temporary, 'source'), node = process.execPath
try {
  await fs.mkdir(target)
  const archive = path.join(temporary, 'main.tar')
  execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', '--output=' + archive, base], { cwd: repository, stdio: 'inherit', timeout: 30000 })
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32/tar.exe') : '/usr/bin/tar'
  execFileSync(tar, ['-xf', archive, '-C', target], { stdio: 'inherit', timeout: 30000 })
  await fs.unlink(archive)
  const nativeFiles = execFileSync('git', ['ls-tree', '-rz', '--name-only', source, 'crabot-native/src'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  const tests = ['process-identity.test.mjs', 'known-process-exit.test.mjs', 'known-process-termination.test.mjs', 'product-runtime.test.mjs',
    'cli-launcher.test.mjs', 'private-file-paths.test.mjs', 'program-references.test.mjs', 'directory-move.test.mjs', 'file-move.test.mjs', 'directory-pin.test.mjs']
  const files = [...nativeFiles, 'scripts/build-native.mjs', 'scripts/lib/product-prepare.mjs', 'scripts/lib/product-runtime.cjs',
    'scripts/lib/process-identity.cjs', 'scripts/lib/known-process-exit.cjs', ...tests.map(name => 'scripts/lib/__tests__/' + name),
    'scripts/lib/__tests__/fixtures/program-reference-build.mjs', 'scripts/lib/__tests__/fixtures/program-reference-holder.cc']
  if (!nativeFiles.length) throw new Error('Native candidate source is absent')
  for (const name of files) {
    const destination = path.join(target, name)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, execFileSync('git', ['show', source + ':' + name], { maxBuffer: 1024 * 1024 }))
  }
  for (const name of ['run-bounded.mjs', 'install-network.mjs', 'scrapling-runtime.cjs']) {
    const original = execFileSync('git', ['show', base + ':scripts/lib/' + name])
    if (!original.equals(await fs.readFile(path.join(target, 'scripts/lib', name)))) throw new Error('Baseline helper changed')
  }
  const cache = path.join(repository, '.desktop-build/native')
  let cached = false
  if (await fs.lstat(cache).then(value => value.isDirectory() && !value.isSymbolicLink(), error => { if (error.code === 'ENOENT') return false; throw error })) {
    await fs.cp(cache, path.join(target, '.desktop-build/native'), { recursive: true, mode: 2 }); cached = true
  }
  // A local warm build must not silently use the network. Clean CI uses the
  // production downloader's exact pinned Node headers/library and SHA-256.
  const imports = []
  if (cached) {
    const blocker = path.join(temporary, 'no-network.mjs')
    await fs.writeFile(blocker, "globalThis.fetch=()=>{throw new Error('review build must use its existing pinned cache')}\n")
    imports.push('--import', blocker)
  }
  execFileSync(node, [...imports, path.join(target, 'scripts/build-native.mjs')], { cwd: target, stdio: 'inherit', timeout: 240000 })
  execFileSync(node, ['--test', ...[...tests, 'install-network.test.mjs'].map(name => path.join(target, 'scripts/lib/__tests__', name))], {
    cwd: target, stdio: 'inherit', timeout: 180000,
  })
  console.log('CRABOT_MAIN_NATIVE_REVIEW ' + JSON.stringify({ baseline: base, candidate: source, overlay_files: files.length,
    main_helper_files_unchanged: true, actual_native_build: true, actual_cli_compiled: true, cli_behavior_tested: true,
    existing_header_cache: cached, network_fetch_disabled: cached, sdk_or_desktop_changes_included: false,
    tested_platform: process.platform + '-' + process.arch, final_pr_boundary: false }))
} finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
