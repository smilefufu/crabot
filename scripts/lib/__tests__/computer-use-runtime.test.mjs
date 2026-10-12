import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import runtime from '../computer-use-runtime.cjs'

const root = resolve(import.meta.dirname, '../../..')
test('failed pinned preparation keeps previous payload and removes staging/lock', async () => {
  const temporary = await fs.mkdtemp(join(tmpdir(), 'cua-prepare-test-'))
  const product = join(temporary, 'product')
  const cache = join(temporary, 'cache')
  try {
    for (const file of ['scripts/prepare-computer-use.mjs', 'scripts/computer-use/runtime.json', 'scripts/lib/computer-use-runtime.cjs', 'scripts/lib/scrapling-prepare.mjs', 'scripts/lib/scrapling-runtime.cjs']) {
      await fs.mkdir(join(product, file, '..'), { recursive: true })
      await fs.copyFile(join(root, file), join(product, file))
    }
    const previous = join(product, '.computer-use-runtime', 'previous-version')
    await fs.mkdir(previous, { recursive: true })
    await fs.writeFile(join(previous, 'payload'), 'previous immutable bytes')
    await fs.mkdir(cache)
    const asset = runtime.pin.assets[`${process.platform}-${process.arch}`]
    if (!asset) return
    await fs.writeFile(join(cache, asset.name), 'invalid download')
    const error = await new Promise(resolve => execFile(process.execPath, [join(product, 'scripts/prepare-computer-use.mjs')], {
      env: { ...process.env, CRABOT_COMPUTER_USE_ASSET_DIR: cache }, timeout: 10_000,
    }, (error, _stdout, stderr) => resolve({ error, stderr })))
    assert.ok(error.error)
    assert.match(error.stderr, /COMPUTER_USE_ASSET_CHECKSUM_MISMATCH/)
    assert.equal(await fs.readFile(join(previous, 'payload'), 'utf8'), 'previous immutable bytes')
    assert.deepEqual(await fs.readdir(join(product, '.computer-use-runtime')), ['previous-version'])
  } finally { await fs.rm(temporary, { recursive: true, force: true }) }
})
