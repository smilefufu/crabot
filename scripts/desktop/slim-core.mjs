// Build candidates only: remove redundant payloads before writing the Core seal.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { runBounded } from '../lib/run-bounded.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'))
const write = (file, value) => fs.writeFile(file, JSON.stringify(value) + '\n')

export async function deduplicatePackages(root) {
  let saved = 0
  // These runtime packages have no dependencies or peers; moving them cannot
  // change their dependency resolution. Never consolidate different versions.
  for (const name of ['zod', 'undici']) {
    const candidates = [path.join(root, 'node_modules', name)]
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^crabot-/.test(entry.name)) candidates.push(path.join(root, entry.name, 'node_modules', name))
    }
    let canonical
    async function snapshot(directory) {
      const files = []
      async function walk(current, relative = '') {
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw new Error('Package contains a link: ' + directory)
          const file = path.join(current, entry.name), name = path.posix.join(relative, entry.name)
          if (entry.isDirectory()) await walk(file, name)
          else if (entry.isFile()) { const bytes = await fs.readFile(file); files.push([name, bytes.length, digest(bytes)]) }
        }
      }
      await walk(directory)
      return { signature: JSON.stringify(files.sort((a, b) => a[0].localeCompare(b[0]))), size: files.reduce((total, file) => total + file[1], 0) }
    }
    for (const directory of candidates) {
      let manifest
      try { manifest = await read(path.join(directory, 'package.json')) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      if (['dependencies', 'peerDependencies', 'optionalDependencies'].some(key => Object.keys(manifest[key] ?? {}).length)) {
        if (directory === candidates[0]) break
        continue
      }
      const current = await snapshot(directory)
      if (!canonical) {
        if (directory !== candidates[0]) { await fs.mkdir(path.dirname(candidates[0]), { recursive: true }); await fs.rename(directory, candidates[0]) }
        canonical = current
      } else if (current.signature === canonical.signature) {
        await fs.rm(directory, { recursive: true }); saved += current.size
      }
    }
  }
  return saved
}

export async function pruneBuildFiles(root, platform = process.platform) {
  const removed = new Set()
  async function remove(directory, predicate) {
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await remove(file, predicate)
      else if (entry.isFile() && predicate(entry.name)) { await fs.unlink(file); removed.add(path.relative(root, file).split(path.sep).join('/')) }
    }
  }
  await remove(path.join(root, 'crabot-native/build/Release'), name => /\.(obj|lib|exp)$/.test(name))
  if (platform === 'win32') {
    for (const directory of ['ucrt64/share/doc', 'usr/share/info', 'usr/share/vim']) {
      // Vim runtime stays intact; only its help directories are documentation.
      const base = path.join(root, '.product-runtime/git', directory)
      if (directory.endsWith('/vim')) {
        let versions = []
        try { versions = await fs.readdir(base) } catch (error) { if (error.code !== 'ENOENT') throw error }
        for (const version of versions) await remove(path.join(base, version, 'doc'), name => !/license|licence|copying|copyright/i.test(name))
      } else await remove(base, name => !/license|licence|copying|copyright/i.test(name))
    }
  }
  return removed
}

async function thinMacOS(root, changed) {
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile()) {
        const handle = await fs.open(file, 'r'), header = Buffer.alloc(8)
        try { await handle.read(header, 0, 8, 0) } finally { await handle.close() }
        if (![0xcafebabe, 0xcafebabf].includes(header.readUInt32BE(0)) || header.readUInt32BE(4) > 16) continue
        await runBounded('/usr/bin/lipo', [file, '-thin', process.arch === 'arm64' ? 'arm64' : 'x86_64', '-output', file + '.thin'], { timeout: 30_000 })
        await fs.rename(file + '.thin', file)
        await runBounded('/usr/bin/codesign', ['--force', '--sign', '-', '--preserve-metadata=identifier,entitlements,flags,runtime', file], { timeout: 30_000 })
        changed.add(path.relative(root, file).split(path.sep).join('/'))
      }
    }
  }
  await walk(root)
  const parent = path.join(root, '.computer-use-runtime')
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const bundle = path.join(parent, entry.name, 'CuaDriver.app')
    await runBounded('/usr/bin/codesign', ['--force', '--sign', '-', '--preserve-metadata=identifier,entitlements,flags,runtime', bundle], { timeout: 30_000 })
    await runBounded('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 30_000 })
    changed.add(path.relative(root, path.join(bundle, 'Contents/_CodeSignature/CodeResources')).split(path.sep).join('/'))
    changed.add(path.relative(root, path.join(bundle, 'Contents/MacOS/cua-driver')).split(path.sep).join('/'))
  }
}

export async function slimCore(root) {
  const product = await read(path.join(root, 'product-runtime.json'))
  const browserIndex = await read(path.join(root, 'scrapling-runtime.json'))
  const browserDirectory = path.join(root, browserIndex.directory)
  const changed = new Set(), removed = await pruneBuildFiles(root)
  if (process.platform === 'darwin') await thinMacOS(root, changed)
  const ready = await read(path.join(browserDirectory, 'ready.json'))
  const inventory = await read(path.join(browserDirectory, 'inventory.json'))
  for (const relative of new Set([ready.node, 'packages/playwright/driver/' + (process.platform === 'win32' ? 'node.exe' : 'node')])) {
    if (!ready.files[relative]) continue // Never remove a shared product interpreter on a repeated build step.
    await fs.rm(path.join(browserDirectory, relative), { force: true })
    delete ready.files[relative]; delete inventory.files[relative]
    removed.add(path.posix.join(browserIndex.directory, relative))
  }
  ready.node = inventory.node = path.relative(browserDirectory, path.join(root, product.executables.node)).split(path.sep).join('/')
  async function refresh(files, prefix) {
    for (const relative of Object.keys(files)) {
      const key = prefix ? path.posix.join(prefix, relative) : relative
      if (removed.has(key)) { delete files[relative]; continue }
      if (!changed.has(key)) continue
      const bytes = await fs.readFile(path.join(root, key))
      files[relative] = typeof files[relative] === 'string' ? digest(bytes) : { ...files[relative], size: bytes.length, sha256: digest(bytes) }
    }
  }
  await refresh(ready.files, browserIndex.directory); await refresh(inventory.files, browserIndex.directory)
  for (const [name, record] of [['ready.json', ready], ['inventory.json', inventory]]) {
    await write(path.join(browserDirectory, name), record); changed.add(path.posix.join(browserIndex.directory, name))
  }
  const cuaParent = path.join(root, '.computer-use-runtime')
  for (const entry of await fs.readdir(cuaParent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const prefix = '.computer-use-runtime/' + entry.name, file = path.join(root, prefix, 'ready.json'), record = await read(file)
    await refresh(record.files, prefix); await write(file, record)
  }
  await refresh(product.files, '')
  await write(path.join(root, 'product-runtime.json'), product)
  return { deduplicated_package_bytes: await deduplicatePackages(root), removed_files: removed.size, updated_resource_files: changed.size }
}
