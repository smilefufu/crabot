// Build host only. Produces the same sealed standalone core for GUI and CLI.
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { runBounded } from '../lib/run-bounded.mjs'
import product from '../lib/product-runtime.cjs'
import scrapling from '../lib/scrapling-runtime.cjs'
import computerUse from '../lib/computer-use-runtime.cjs'
import { writeCoreRelease, verifyCoreRelease } from '../lib/core-release.mjs'

const excluded = new Set(['node_modules', 'node_modules_link_check', '.git', '.env', '.venv', '__pycache__', '__tests__', 'tests', 'test'])
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const trackedFiles = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))
const trackedDirectories = new Set([''])
for (const file of trackedFiles) {
  let parent = path.posix.dirname(file)
  while (parent !== '.') { trackedDirectories.add(parent); parent = path.posix.dirname(parent) }
}
async function copySource(source, target, { module = false, python = false } = {}) {
  await fs.cp(source, target, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
    filter: item => {
      const relative = path.relative(source, item), parts = relative.split(path.sep)
      const repositoryPath = path.relative(root, item).split(path.sep).join('/')
      const compiled = repositoryPath === 'dist' || repositoryPath.startsWith('dist/') || /^crabot-[^/]+\/dist(?:\/|$)/.test(repositoryPath)
      if (!compiled && !trackedFiles.has(repositoryPath) && !trackedDirectories.has(repositoryPath)) return false
      if (parts.some(part => excluded.has(part))) return false
      if (parts.some(part => part.startsWith('.') && part !== '.npmrc')) return relative === ''
      if (module && !python && (parts[0] === 'src' || parts[0] === 'web')) return false
      return !/^(?:vitest|tsconfig)(?:\.|$)/.test(path.basename(item)) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(item)
    } })
}

const options = new Map(process.argv.slice(2).map(value => { const split = value.indexOf('='); return [value.slice(0, split), value.slice(split + 1)] }))
const destination = options.get('--out'), version = options.get('--version')
if (!destination || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version ?? '')) throw new Error('Usage: stage-core.mjs --out=<new-directory> --version=<semver>')
const output = path.resolve(destination)
if (output === root || !path.relative(root, output).startsWith('.desktop-build' + path.sep)) throw new Error('Core staging must be a new directory under .desktop-build')
try { await fs.lstat(output); throw new Error('Core staging already exists; choose a fresh candidate directory') } catch (error) { if (error.code !== 'ENOENT') throw error }
const runtime = product.loadProductRuntime(root, { required: true, full: true })
scrapling.loadRuntime(root, { full: true })
const cua = computerUse.loadRuntime(root, { full: true })
const nodeEnv = product.productEnvironment(runtime, path.join(root, '.desktop-build/build-cache'), process.env)
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const sourceDirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
if (sourceDirty && options.get('--allow-dirty') !== 'true') throw new Error('Release staging requires committed sources; development candidates may use --allow-dirty=true')
const modules = ['crabot-client', 'crabot-shared', 'crabot-core', 'crabot-agent', 'crabot-admin', 'crabot-mcp-tools',
  'crabot-channel-telegram', 'crabot-channel-wechat', 'crabot-channel-feishu', 'crabot-channel-dingtalk', 'crabot-channel-voice']
// Rebuild the actual sources before taking the immutable snapshot. Checking that
// dist exists is insufficient: a local candidate could otherwise contain old UI.
for (const module of modules) {
  await runBounded(runtime.executables.node, [path.join(root, module, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    { cwd: path.join(root, module), timeout: 120_000 })
}
await runBounded(runtime.executables.node, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.cli.json'], { cwd: root, timeout: 120_000 })
for (const [directory, script, args] of [
  ['crabot-admin/web', 'node_modules/typescript/bin/tsc', ['-p', 'tsconfig.json']],
  ['crabot-admin/web', 'node_modules/vite/bin/vite.js', ['build']],
  ['crabot-desktop', 'node_modules/typescript/bin/tsc', ['-p', 'tsconfig.json']],
  ['crabot-desktop', 'build-preload.mjs', []],
]) await runBounded(runtime.executables.node, [path.join(root, directory, script), ...args], { cwd: path.join(root, directory), timeout: 120_000 })
await runBounded(runtime.executables.node, [path.join(root, 'scripts/build-native.mjs')], { cwd: root, timeout: 120_000 })
for (const module of modules) await fs.access(path.join(root, module, 'dist'))
await fs.access(path.join(root, 'dist/cli/main.js'))
await fs.access(path.join(root, 'crabot-native/build/Release/crabot-native.node'))
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.mkdir(output)
try {
  for (const file of ['cli.mjs', 'package.json', 'pnpm-lock.yaml', '.npmrc', 'LICENSE', 'install.sh', 'install.ps1']) await fs.copyFile(path.join(root, file), path.join(output, file))
  await copySource(path.join(root, 'dist'), path.join(output, 'dist'))
  await copySource(path.join(root, 'scripts'), path.join(output, 'scripts'))
  for (const module of modules) await copySource(path.join(root, module), path.join(output, module), { module: true })
  await copySource(path.join(root, 'crabot-memory'), path.join(output, 'crabot-memory'), { module: true, python: true })
  await fs.cp(path.join(root, 'crabot-native/build/Release'), path.join(output, 'crabot-native/build/Release'), { recursive: true })
  const cuaRelative = path.relative(root, cua.directory).split(path.sep).join('/')
  const resourceFiles = new Set([...Object.keys(runtime.manifest.files), ...Object.keys(JSON.parse(await fs.readFile(path.join(cua.directory, 'ready.json'), 'utf8')).files)
    .map(file => cuaRelative + '/' + file), cuaRelative + '/ready.json'])
  const resourceDirectories = new Set()
  for (const file of resourceFiles) {
    let parent = path.posix.dirname(file)
    while (parent !== '.') { resourceDirectories.add(parent); parent = path.posix.dirname(parent) }
  }
  for (const directory of new Set([...resourceFiles].map(file => file.split('/')[0]))) {
    await fs.cp(path.join(root, directory), path.join(output, directory), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
      filter: async item => {
        const relative = path.relative(root, item).split(path.sep).join('/')
        if (resourceFiles.has(relative) || resourceDirectories.has(relative)) return true
        // macOS Framework directory aliases aren't traversed by the inventory.
        // Keep only aliases to directories already covered by that inventory.
        if (!(await fs.lstat(item)).isSymbolicLink()) return false
        const real = path.relative(root, await fs.realpath(item)).split(path.sep).join('/')
        return resourceDirectories.has(real)
      } })
  }
  await fs.copyFile(path.join(root, 'scrapling-runtime.json'), path.join(output, 'scrapling-runtime.json'))
  await fs.writeFile(path.join(output, 'product-runtime.json'), JSON.stringify({ ...runtime.manifest, version }))
  const packageJson = JSON.parse(await fs.readFile(path.join(output, 'package.json'), 'utf8'))
  await fs.writeFile(path.join(output, 'package.json'), JSON.stringify({ ...packageJson, version }, null, 2) + '\n')
  // Frozen production installs happen only in this build candidate. Never prune
  // the developer checkout or install anything on the eventual user's machine.
  for (const directory of ['crabot-client', 'crabot-shared', '', 'scripts/lib', ...modules.slice(2)]) {
    const args = ['install', '--prod', '--frozen-lockfile', '--node-linker=hoisted', '--package-import-method=copy', '--prefer-offline']
    const corepack = path.join(path.dirname(runtime.executables.node), process.platform === 'win32' ? 'node_modules/corepack/dist/corepack.js' : '../lib/node_modules/corepack/dist/corepack.js')
    await runBounded(runtime.executables.node, [corepack, 'pnpm@9.15.9', ...args],
      { cwd: path.join(output, directory), env: nodeEnv, timeout: 10 * 60_000 })
  }
  await fs.mkdir(path.join(output, 'bin'))
  const nativeCommand = process.platform === 'win32' ? 'crabot.exe' : 'crabot'
  await fs.copyFile(path.join(root, 'crabot-native/build/Release', nativeCommand), path.join(output, 'bin', nativeCommand))
  if (process.platform !== 'win32') await fs.chmod(path.join(output, 'bin/crabot'), 0o755)
  const cmd = relative => '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%~dp0' + relative + 'bin\\crabot.exe" %*\r\nexit /b %errorlevel%\r\n'
  await fs.writeFile(path.join(output, 'bin/crabot.cmd'), cmd('..\\'))
  await fs.writeFile(path.join(output, 'crabot.cmd'), cmd(''))
  async function preparePayload(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name)
      if (item.isSymbolicLink()) {
        const relative = path.relative(output, await fs.realpath(file))
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Core package link escapes its installation: ' + path.relative(output, file))
      } else if (item.isDirectory()) {
        await preparePayload(file)
        if (process.platform !== 'win32') await fs.chmod(file, 0o755)
      } else if (item.isFile() && process.platform !== 'win32') {
        // Sealed product files contain no user secrets. Portable public read
        // permissions also let employees execute the same root-installed core.
        const stat = await fs.stat(file)
        await fs.chmod(file, stat.mode & 0o111 ? 0o755 : 0o644)
      }
    }
  }
  await preparePayload(output)
  product.loadProductRuntime(output, { required: true, full: true })
  scrapling.loadRuntime(output, { full: true })
  computerUse.loadRuntime(output, { full: true })
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== commit
    || !sourceDirty && execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) {
    throw new Error('Sources changed while staging; build a fresh candidate from committed sources')
  }
  // This reader transitively loads the native helper. Load it only after the
  // compiler has finished; Windows cannot replace a DLL loaded by this parent.
  const { readWorkspaceDataVersions } = await import('../lib/workspace-data-compat.mjs')
  if (!readWorkspaceDataVersions(output).includes(1)) throw new Error('Staged Core is missing its workspace data compatibility declaration')
  const inventory = await writeCoreRelease(output, { schema_version: 1, version, platform: process.platform, arch: process.arch, commit, source_dirty: sourceDirty })
  await verifyCoreRelease(output, { version })
  console.log('Core inventory: ' + JSON.stringify(inventory))
  console.log('Core candidate staged: ' + output)
} catch (error) {
  // The failed candidate is ours and has never been published or used as DATA_DIR.
  await fs.rm(output, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  throw error
}
