import { promises as fs, createReadStream, createWriteStream } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { runBounded } from './run-bounded.mjs'
import { selectPackageSource, withPackageSource, uvTransport } from './install-network.mjs'
import scrapling from './scrapling-runtime.cjs'
import product from './product-runtime.cjs'

const windows = process.platform === 'win32'

export async function digestFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function downloadProductAsset(asset, directory, { signal, fetcher = fetch } = {}) {
  if (!/^[a-f0-9]{64}$/.test(asset.sha256) || new URL(asset.url).protocol !== 'https:') {
    throw new Error('Invalid pinned product asset')
  }
  const name = new URL(asset.url).pathname.split('/').at(-1)
  if (!name || name === '.' || name === '..') throw new Error('Invalid product asset filename')
  await fs.mkdir(directory, { recursive: true })
  const target = join(directory, asset.sha256.slice(0, 12) + '-' + name)
  try {
    if (await digestFile(target) === asset.sha256) return target
    await fs.unlink(target)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const pending = target + '.part-' + randomUUID()
  try {
    const requestSignal = AbortSignal.any([AbortSignal.timeout(180_000), ...(signal ? [signal] : [])])
    requestSignal.throwIfAborted()
    let url = asset.url
    let response
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (new URL(url).protocol !== 'https:') throw new Error('Product asset requires HTTPS')
      response = await fetcher(url, { signal: requestSignal, redirect: 'manual' })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location || redirects === 5) throw new Error('Invalid product asset redirect')
      url = new URL(location, url).href
    }
    if (!response.ok || !response.body) throw new Error('Product asset download failed: HTTP ' + response.status)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(pending, { flags: 'wx' }), { signal: requestSignal })
    if (await digestFile(pending) !== asset.sha256) throw new Error('Product asset SHA-256 mismatch: ' + name)
    await fs.rename(pending, target)
    return target
  } finally {
    await fs.rm(pending, { force: true })
  }
}

async function unpack(archive, destination, strip, signal) {
  await fs.mkdir(destination, { recursive: true })
  const tar = windows ? join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar'
  await runBounded(tar, ['-xf', archive, '-C', destination, '--strip-components=' + strip], { signal })
}

async function inventory(root, directory, files = {}) {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const target = join(directory, item.name)
    const stat = await fs.stat(target)
    const real = await fs.realpath(target)
    const location = relative(root, real)
    if (location === '..' || location.startsWith('../') || location.startsWith('..\\')) {
      throw new Error('Product resource escaped installation: ' + target)
    }
    if (stat.isDirectory()) {
      // Framework aliases stay relative and inside the installation; don't traverse alias cycles.
      if (!item.isSymbolicLink()) await inventory(root, target, files)
    } else if (stat.isFile()) {
      files[relative(root, target).split('\\').join('/')] = { size: stat.size, sha256: await digestFile(target) }
    }
  }
  return files
}

async function license(root, name, version, url) {
  await fs.mkdir(join(root, 'licenses'), { recursive: true })
  await fs.appendFile(join(root, 'licenses', 'SOURCES.txt'), name + ' ' + version + '\n' + url + '\n\n')
}

export async function prepareProductRuntime(root, { cache, version = 'desktop-dev', signal, logger = console } = {}) {
  root = await fs.realpath(root)
  const configRoot = join(root, 'scripts', 'desktop')
  const config = JSON.parse(await fs.readFile(join(configRoot, 'runtime.json'), 'utf8'))
  const seeds = JSON.parse(await fs.readFile(join(configRoot, 'python-seed.json'), 'utf8'))
  const target = process.platform + '-' + process.arch
  if (!config.node[target] || !config.uv[target] || !config.rg[target]) throw new Error('Unsupported product runtime: ' + target)
  // Scrapling is a separately locked product environment. Its producer runs at build time.
  const browser = scrapling.loadRuntime(root, { full: true })
  if (browser.manifest.versions.python !== config.versions.python) throw new Error('Product Python version mismatch')
  const input = createHash('sha256').update(browser.manifest.fingerprint)
  for (const file of [join(configRoot, 'runtime.json'), join(configRoot, 'python-seed.json'), join(configRoot, 'build-unix-tools.sh'), join(root, 'crabot-memory', 'uv.lock')]) {
    input.update(await fs.readFile(file))
  }
  const fingerprint = input.digest('hex')
  const prior = product.loadProductRuntime(root, { full: true })
  if (prior) {
    if (prior.manifest.version !== version || prior.manifest.input_fingerprint !== fingerprint) throw new Error('Build a changed product version in a fresh staging directory')
    return prior
  }
  cache ??= join(root, '.desktop-build', 'downloads')
  const directory = join(root, '.product-runtime')
  await fs.mkdir(dirname(cache), { recursive: true })
  const work = await fs.mkdtemp(join(dirname(cache), 'build-'))
  let ownsDirectory = false
  let pending
  const run = (command, args, options = {}) => runBounded(command, args, { signal, ...options })
  try {
    signal?.throwIfAborted()
    await fs.mkdir(directory) // Do not overwrite another build or an unrecognized existing directory.
    ownsDirectory = true
    const nodeAsset = config.node[target]
    const nodeUrl = 'https://nodejs.org/dist/v' + config.versions.node + '/' + nodeAsset.name
    const nodeArchive = await downloadProductAsset({ ...nodeAsset, url: nodeUrl }, cache, { signal })
    await unpack(nodeArchive, join(directory, 'node'), 1, signal)
    await license(directory, 'Node.js (including npm)', config.versions.node, nodeUrl)

    const uvAsset = config.uv[target]
    const uvUrl = 'https://github.com/astral-sh/uv/releases/download/' + config.versions.uv + '/' + uvAsset.name
    const uvArchive = await downloadProductAsset({ ...uvAsset, url: uvUrl }, cache, { signal })
    await unpack(uvArchive, join(directory, 'uv'), windows ? 0 : 1, signal)
    const uv = join(directory, 'uv', windows ? 'uv.exe' : 'uv')
    await license(directory, 'uv', config.versions.uv, uvUrl)

    const rgAsset = config.rg[target]
    const rgUrl = 'https://github.com/BurntSushi/ripgrep/releases/download/' + config.versions.rg + '/' + rgAsset.name
    const rgArchive = await downloadProductAsset({ ...rgAsset, url: rgUrl }, cache, { signal })
    await unpack(rgArchive, join(directory, 'rg'), 1, signal)
    await license(directory, 'ripgrep', config.versions.rg, rgUrl)

    if (windows) {
      const git = config.portable_git
      const url = 'https://github.com/git-for-windows/git/releases/download/v' + git.version + '/' + git.name
      const archive = await downloadProductAsset({ ...git, url }, cache, { signal })
      await run('7z', ['x', archive, '-o' + join(directory, 'git'), '-y'])
      await license(directory, 'Git for Windows/Bash', git.version, url)
    } else {
      const bash = await downloadProductAsset(config.unix_sources.bash, cache, { signal })
      const git = await downloadProductAsset(config.unix_sources.git, cache, { signal })
      logger.info('Building private Bash and Git')
      await run('/bin/bash', [join(configRoot, 'build-unix-tools.sh'), bash, git, directory, join(work, 'unix')])
      await license(directory, 'Bash', config.versions.bash, config.unix_sources.bash.url)
      await license(directory, 'Git', config.versions.git, config.unix_sources.git.url)
    }

    const seedDirectory = join(directory, 'seeds')
    await fs.mkdir(seedDirectory)
    for (const [name, asset] of Object.entries(seeds)) {
      const archive = await downloadProductAsset(asset, cache, { signal })
      await fs.copyFile(archive, join(seedDirectory, asset.filename))
      await license(directory, name, asset.version, asset.url)
    }

    const memory = join(root, 'crabot-memory')
    const requirements = join(work, 'memory-requirements.txt')
    let env = { ...process.env, UV_CACHE_DIR: join(cache, 'uv'), UV_PYTHON_DOWNLOADS: 'never', PYTHONNOUSERSITE: '1' }
    env = { ...env, ...await uvTransport(uv, root, env) }
    await run(uv, ['export', '--frozen', '--no-dev', '--no-emit-project', '--output-file', requirements], { cwd: memory, env })
    const source = await selectPackageSource('python', { logger, env })
    const memoryPackages = join(directory, 'memory-packages')
    await withPackageSource(source, (index, child, timeout) => run(uv, [
      'pip', 'sync', '--python', join(browser.directory, browser.manifest.command),
      '--target', memoryPackages, '--only-binary', ':all:', '--require-hashes',
      '--index', index, '--default-index', index, requirements,
    ], { cwd: memory, env: child, timeout, captureError: true }), { env, logger })
    await fs.copyFile(requirements, join(directory, 'licenses', 'memory-requirements.txt'))

    const rel = file => relative(root, file).split('\\').join('/')
    const commands = {
      node: join(directory, 'node', windows ? 'node.exe' : 'bin/node'),
      python: join(browser.directory, browser.manifest.command),
      uv, bash: join(directory, windows ? 'git/bin/bash.exe' : 'bin/bash'),
      git: join(directory, windows ? 'git/cmd/git.exe' : 'bin/git'),
      rg: join(directory, 'rg', windows ? 'rg.exe' : 'rg'),
    }
    const paths = windows
      ? ['node', 'uv', 'rg', 'git/cmd', 'git/usr/bin']
      : ['node/bin', 'uv', 'rg', 'bin']
    const files = await inventory(root, directory)
    await inventory(root, browser.directory, files)
    const manifest = {
      schema_version: 1, version, input_fingerprint: fingerprint, platform: process.platform, arch: process.arch,
      versions: config.versions,
      executables: Object.fromEntries(Object.entries(commands).map(([name, file]) => [name, rel(file)])),
      path_entries: paths.map(p => rel(join(directory, p))),
      python_home: rel(join(browser.directory, 'python')),
      memory_packages: rel(memoryPackages),
      seed_wheels: (await fs.readdir(seedDirectory)).map(name => rel(join(seedDirectory, name))),
      browser: rel(join(browser.directory, browser.manifest.browser)),
      files,
    }
    signal?.throwIfAborted()
    pending = join(root, 'product-runtime.json.tmp-' + randomUUID())
    await fs.writeFile(pending, JSON.stringify(manifest) + '\n')
    await fs.rename(pending, join(root, 'product-runtime.json'))
    const ready = product.loadProductRuntime(root, { required: true, full: true })
    logger.info('Product runtime ready: ' + target)
    return ready
  } catch (error) {
    if (pending) await fs.rm(pending, { force: true })
    if (ownsDirectory) {
      await fs.rm(join(root, 'product-runtime.json'), { force: true })
      await fs.rm(directory, { recursive: true, force: true })
    }
    throw error
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}
