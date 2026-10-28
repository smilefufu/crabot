// Finite legacy-Python test support only. This is not a product runtime build:
// unused Bash/Git/rg slots alias Node; complete capability acceptance is separate.
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { downloadProductAsset, digestFile } from '../../scripts/lib/product-prepare.mjs'
import product from '../../scripts/lib/product-runtime.cjs'

const root = fileURLToPath(new URL('../../', import.meta.url)), runtime = path.join(root, '.product-runtime')
for (const file of ['.product-runtime', 'product-runtime.json']) {
  if (await fs.lstat(path.join(root, file)).catch(error => { if (error.code !== 'ENOENT') throw error })) throw new Error('Test runtime already exists; preserving it')
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR)$/i.test(key)))
const run = (command, args) => execFileSync(command, args, { env: { ...env, UV_OFFLINE: '1', UV_PYTHON_DOWNLOADS: 'never', UV_NO_CONFIG: '1' }, encoding: 'utf8', timeout: 30000 }).trim()
const python = process.env.CRABOT_TEST_PYTHON ?? run('uv', ['python', 'find', '3.12.12'])
const details = JSON.parse(run(python, ['-I', '-S', '-B', '-c', 'import json,sys;print(json.dumps({"home":sys.base_prefix,"version":".".join(map(str,sys.version_info[:3]))}))']))
if (details.version !== '3.12.12' || process.versions.node !== '22.22.3') throw new Error('Use the fixed test interpreters')
const uv = process.env.CRABOT_TEST_UV ?? (process.platform === 'win32'
  ? run('where.exe', ['uv']).split(/\r?\n/)[0] : run('/bin/sh', ['-c', 'command -v uv']))
if (run(uv, ['--version']).split(/\s+/)[1] !== '0.13.0') throw new Error('Use the fixed uv test runner')
const seeds = JSON.parse(await fs.readFile(path.join(root, 'scripts/desktop/python-seed.json'), 'utf8'))
await fs.mkdir(runtime)
const binary = path.join(runtime, 'bin'); await fs.mkdir(binary)
const nodeRelative = '.product-runtime/bin/node' + (process.platform === 'win32' ? '.exe' : '')
const uvRelative = '.product-runtime/bin/uv' + (process.platform === 'win32' ? '.exe' : '')
await fs.copyFile(process.execPath, path.join(root, nodeRelative), constants.COPYFILE_FICLONE)
await fs.copyFile(uv, path.join(root, uvRelative), constants.COPYFILE_FICLONE)
const home = await fs.realpath(details.home), executable = await fs.realpath(python)
const within = path.relative(home, executable)
if (!within || within.startsWith('..') || path.isAbsolute(within)) throw new Error('Python must belong to its distribution')
await fs.cp(home, path.join(runtime, 'python'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
await fs.mkdir(path.join(runtime, 'memory-packages'))
await fs.mkdir(path.join(runtime, 'seeds'))
for (const asset of Object.values(seeds)) {
  const source = process.env.CRABOT_TEST_SEEDS ? path.join(process.env.CRABOT_TEST_SEEDS, asset.filename)
    : await downloadProductAsset(asset, path.join(root, '.desktop-build/downloads'))
  if (await digestFile(source) !== asset.sha256) throw new Error('Changed test seed wheel')
  await fs.copyFile(source, path.join(runtime, 'seeds', asset.filename), constants.COPYFILE_FICLONE)
}
const files = {}
async function inventory(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) await inventory(file)
    else if (entry.isFile()) {
      const name = path.relative(root, file).split(path.sep).join('/')
      files[name] = { size: (await fs.stat(file)).size, sha256: await digestFile(file) }
    }
  }
}
await inventory(runtime)
const pythonRelative = path.relative(root, path.join(runtime, 'python', within)).split(path.sep).join('/')
const manifest = { schema_version: 1, version: 'legacy-python-test', platform: process.platform, arch: process.arch,
  versions: { python: details.version, node: process.versions.node }, files,
  executables: { node: nodeRelative, python: pythonRelative, uv: uvRelative, bash: nodeRelative, git: nodeRelative, rg: nodeRelative },
  path_entries: ['.product-runtime/bin'], python_home: '.product-runtime/python', memory_packages: '.product-runtime/memory-packages',
  seed_wheels: Object.values(seeds).map(asset => '.product-runtime/seeds/' + asset.filename) }
await fs.writeFile(path.join(root, 'product-runtime.json'), JSON.stringify(manifest) + '\n', { flag: 'wx' })
product.loadProductRuntime(root, { required: true, full: true })
console.log('Verified finite legacy-Python test runtime; full desktop capabilities are not claimed')
