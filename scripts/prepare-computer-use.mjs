import { promises as fs } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { runBounded } from './lib/scrapling-prepare.mjs'
import runtime from './lib/computer-use-runtime.cjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { pin } = runtime
const asset = pin.assets[`${process.platform}-${process.arch}`]
if (!asset) throw new Error(`COMPUTER_USE_PLATFORM_UNSUPPORTED: ${process.platform}-${process.arch}`)
if (process.argv.includes('--check')) { runtime.loadRuntime(root, { full: true }); process.exit(0) }
try { runtime.loadRuntime(root, { full: true }); process.exit(0) } catch { /* Prepare outside MCP. */ }
const parent = join(root, '.computer-use-runtime')
await fs.mkdir(parent, { recursive: true })
const lock = join(parent, 'prepare.lock')
await fs.mkdir(lock) // A concurrent preparer fails without replacing any usable payload.
const stage = join(parent, `stage-${randomUUID()}`)
try {
  await fs.mkdir(stage)
  const cache = process.env.CRABOT_COMPUTER_USE_ASSET_DIR
  let data
  if (cache) data = await fs.readFile(join(resolve(cache), asset.name))
  else {
    const response = await fetch(`https://github.com/trycua/cua/releases/download/${pin.tag}/${asset.name}`, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`Driver download: ${response.status}`)
    data = Buffer.from(await response.arrayBuffer())
  }
  if (createHash('sha256').update(data).digest('hex') !== asset.sha256) throw new Error('COMPUTER_USE_ASSET_CHECKSUM_MISMATCH')
  const archive = join(stage, asset.name)
  await fs.writeFile(archive, data)
  await runBounded('tar', ['-xf', archive, '-C', stage], { timeout: 120_000 })
  await fs.unlink(archive)
  const payload = asset.prefix ? join(stage, asset.prefix) : stage
  if (process.platform === 'darwin') await runBounded('codesign', ['--verify', '--deep', '--strict', join(payload, 'CuaDriver.app')], { timeout: 30_000 })
  const files = {}
  async function inventory(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await inventory(join(directory, entry.name), relative)
      else if (entry.isFile()) files[relative] = createHash('sha256').update(await fs.readFile(join(directory, entry.name))).digest('hex')
    }
  }
  await inventory(payload)
  await fs.writeFile(join(payload, 'ready.json'), JSON.stringify({ version: pin.version, sha256: asset.sha256, files }))
  const destination = join(parent, `${pin.version}-${process.platform}-${process.arch}`)
  // Verified staging only. A previous usable version is kept when any earlier step fails.
  const previous = `${destination}.previous-${randomUUID()}`
  const exists = await fs.stat(destination).then(() => true, () => false)
  if (exists) await fs.rename(destination, previous)
  try { await fs.rename(payload, destination) } catch (error) { if (exists) await fs.rename(previous, destination); throw error }
  if (exists) await fs.rm(previous, { recursive: true, force: true })
  runtime.loadRuntime(root, { full: true })
  console.log(`Cua Driver ${pin.version} prepared for ${process.platform}-${process.arch}`)
} finally { await fs.rm(stage, { recursive: true, force: true }); await fs.rm(lock, { recursive: true, force: true }) }
