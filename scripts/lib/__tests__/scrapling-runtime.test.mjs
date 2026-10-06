import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import runtime from '../scrapling-runtime.cjs'
import { prepareRuntime, runBounded } from '../scrapling-prepare.mjs'
const repo = new URL('../../../', import.meta.url)
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'scrapling-runtime-'))
  await fs.cp(new URL('scripts/scrapling/', repo), join(root, 'scripts/scrapling'), { recursive: true })
  await fs.mkdir(join(root, 'scripts/lib'), { recursive: true })
  for (const name of ['scrapling-runtime.cjs', 'scrapling-prepare.mjs']) await fs.copyFile(new URL(`scripts/lib/${name}`, repo), join(root, 'scripts/lib', name))
  return root
}
async function builder(root, directory) {
  const files = {}
  for (const name of ['python-launcher', 'node-launcher', 'chromium-launcher', 'server.py']) {
    const body = Buffer.from(name)
    await fs.writeFile(join(directory, name), body)
    files[name] = { size: body.length, sha256: createHash('sha256').update(body).digest('hex') }
  }
  await fs.writeFile(join(directory, 'inventory.json'), JSON.stringify({ files, command: 'python-launcher', node: 'node-launcher', browser: 'chromium-launcher' }))
}
const entry = { name: 'scrapling', is_builtin: true, enabled: true, command: 'scrapling', args: ['mcp'] }
test('sealed runtime relocates; custom commands and nonbuiltin names preserve their exact config', async () => {
  const root = await fixture()
  const moved = root + '-moved'
  try {
    await prepareRuntime(root, { builder })
    await fs.rename(root, moved)
    const config = { id: 'preserved-id', name: 'scrapling', command: 'scrapling', args: ['mcp'], env: { CUSTOM: 'kept' } }
    const parsed = runtime.resolveScraplingConfig(moved, join(moved, 'instance'), entry, config)
    assert.ok(parsed.command.startsWith(moved))
    assert.deepEqual(parsed.args.slice(0, 2), ['-I', '-B'])
    assert.equal(parsed.id, config.id)
    assert.equal(parsed.env.CUSTOM, 'kept')
    assert.equal(parsed.env.BROWSER_CDP_URL, undefined)
    assert.equal(runtime.resolveScraplingConfig(moved, '', { ...entry, is_builtin: false }, config), config)
    assert.equal(runtime.resolveScraplingConfig(moved, '', { ...entry, args: ['mcp', '--http'] }, config), config)
    const warm = await prepareRuntime(moved, { builder: () => { throw Error('must not download') } })
    await fs.writeFile(join(warm.directory, 'node-launcher'), 'damaged')
    assert.throws(() => runtime.loadRuntime(moved, { full: true }), /damaged|checksum/)
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(moved, { recursive: true, force: true }) }
})
test('failed preparation has no pointer or ready environment; retry succeeds and preserves old versions', async () => {
  const root = await fixture()
  try {
    await fs.mkdir(join(root, '.scrapling-runtime-old'))
    await assert.rejects(prepareRuntime(root, { builder: async () => { throw Error('download failed') } }), /download failed/)
    assert.deepEqual((await fs.readdir(root)).sort(), ['.scrapling-runtime-old', 'scripts'])
    await prepareRuntime(root, { builder })
    assert.ok((await fs.readdir(root)).includes('.scrapling-runtime-old'))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
test('bounded lock contention and interrupted-owner recovery', async () => {
  const root = await fixture()
  try {
    const lock = join(root, '.scrapling-prepare.lock')
    await fs.mkdir(lock); await fs.writeFile(join(lock, 'pid'), String(process.pid))
    await assert.rejects(prepareRuntime(root, { builder, lockTimeout: 1 }), /lock timed out/)
    await fs.unlink(join(lock, 'pid'))
    const old = new Date(Date.now() - 10000)
    await fs.utimes(lock, old, old)
    await prepareRuntime(root, { builder })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
test('closed/custom registry does not require product dependencies; absent new registry does', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'scrapling-registry-'))
  try {
    assert.equal(runtime.runtimeRequired(root), true)
    await fs.mkdir(join(root, 'admin'))
    for (const value of [{ ...entry, enabled: false }, { ...entry, args: ['custom'] }, { ...entry, is_builtin: false }]) {
      await fs.writeFile(join(root, 'admin/mcp-servers.json'), JSON.stringify([value]))
      assert.equal(runtime.runtimeRequired(root), false)
    }
    await fs.writeFile(join(root, 'admin/mcp-servers.json'), JSON.stringify([entry]))
    assert.equal(runtime.runtimeRequired(root), true)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
test('preparation subprocess failure, timeout and cancellation fail explicitly', async () => {
  await assert.rejects(runBounded(process.execPath, ['-e', 'process.exit(3)']), /code 3/)
  await assert.rejects(runBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 30 }), /timed out/)
  const abort = new AbortController()
  setTimeout(() => abort.abort(), 30)
  await assert.rejects(runBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: abort.signal }), /cancelled/)
})
test('failed subprocess terminates its owned grandchildren', async () => {
  if (process.platform === 'win32') return
  const dir = await fs.mkdtemp(join(tmpdir(), 'scrapling-process-'))
  const pidFile = join(dir, 'pid')
  try {
    const source = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));setTimeout(()=>process.exit(4),100)`
    await assert.rejects(runBounded(process.execPath, ['-e', source, pidFile]), /code 4/)
    const pid = Number(await fs.readFile(pidFile, 'utf8'))
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.throws(() => process.kill(pid, 0), /ESRCH/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
