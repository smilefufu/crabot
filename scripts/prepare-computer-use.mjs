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
const stage = join(parent, `stage-${randomUUID()}`)
try { await fs.mkdir(lock) } catch (error) {
  if (error.code !== 'EEXIST') throw error
  const owner = JSON.parse(await fs.readFile(join(lock, 'owner.json'), 'utf8'))
  try { process.kill(owner.pid, 0); throw new Error('COMPUTER_USE_PREPARATION_BUSY') }
  catch (checkError) { if (checkError.code !== 'ESRCH') throw checkError }
  if (!/^stage-[0-9a-f-]+$/.test(owner.stage)) throw new Error('COMPUTER_USE_PREPARATION_LOCK_INVALID')
  await fs.rm(join(parent, owner.stage), { recursive: true, force: true })
  await fs.rm(lock, { recursive: true })
  await fs.mkdir(lock)
}
await fs.writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, stage: stage.split(/[\\/]/).at(-1) }))
const controller = new AbortController()
const cancel = () => { controller.abort(); process.exitCode = 130 }
process.once('SIGINT', cancel)
process.once('SIGTERM', cancel)
try {
  await fs.mkdir(stage)
  const cache = process.env.CRABOT_COMPUTER_USE_ASSET_DIR
  let data
  if (cache) data = await fs.readFile(join(resolve(cache), asset.name))
  else {
    const response = await fetch(`https://github.com/trycua/cua/releases/download/${pin.tag}/${asset.name}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]) })
    if (!response.ok) throw new Error(`Driver download: ${response.status}`)
    data = Buffer.from(await response.arrayBuffer())
  }
  if (createHash('sha256').update(data).digest('hex') !== asset.sha256) throw new Error('COMPUTER_USE_ASSET_CHECKSUM_MISMATCH')
  const archive = join(stage, asset.name)
  await fs.writeFile(archive, data)
  await runBounded('tar', ['-xf', asset.name], { cwd: stage, timeout: 120_000, signal: controller.signal })
  await fs.unlink(archive)
  const payload = asset.prefix ? join(stage, asset.prefix) : stage
  if (process.platform === 'darwin') await runBounded('codesign', ['--verify', '--deep', '--strict', join(payload, 'CuaDriver.app')], { timeout: 30_000, signal: controller.signal })
  const files = {}
  async function inventory(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      controller.signal.throwIfAborted()
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await inventory(join(directory, entry.name), relative)
      else if (entry.isFile()) files[relative] = createHash('sha256').update(await fs.readFile(join(directory, entry.name))).digest('hex')
    }
  }
  await inventory(payload)
  await fs.writeFile(join(payload, 'ready.json'), JSON.stringify({ version: pin.version, sha256: asset.sha256, files }))
  controller.signal.throwIfAborted()
  const destination = join(parent, `${pin.version}-${process.platform}-${process.arch}`)
  // Verified staging only. A previous usable version is kept when any earlier step fails.
  const previous = `${destination}.previous-${randomUUID()}`
  const exists = await fs.stat(destination).then(() => true, () => false)
  if (exists) await fs.rename(destination, previous)
  try { await fs.rename(payload, destination) } catch (error) { if (exists) await fs.rename(previous, destination); throw error }
  if (exists) await fs.rm(previous, { recursive: true, force: true })
  runtime.loadRuntime(root, { full: true })
  console.log(`Cua Driver ${pin.version} prepared for ${process.platform}-${process.arch}`)
} finally {
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel)
  await fs.rm(stage, { recursive: true, force: true }); await fs.rm(lock, { recursive: true, force: true })
}
