import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
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

test('prepares a real Windows ZIP under a drive-like path even when PATH tar cannot read ZIP', async () => {
  const temporary = await fs.mkdtemp(join(tmpdir(), 'cua-windows-prepare-'))
  const product = join(temporary, process.platform === 'win32' ? 'product with spaces' : 'D:product with spaces')
  const cache = join(temporary, 'cache')
  const run = promisify(execFile)
  try {
    for (const file of ['scripts/prepare-computer-use.mjs', 'scripts/computer-use/runtime.json', 'scripts/lib/computer-use-runtime.cjs', 'scripts/lib/scrapling-prepare.mjs', 'scripts/lib/scrapling-runtime.cjs']) {
      await fs.mkdir(join(product, file, '..'), { recursive: true })
      await fs.copyFile(join(root, file), join(product, file))
    }
    await fs.mkdir(cache)
    const pinPath = join(product, 'scripts/computer-use/runtime.json')
    const pin = JSON.parse(await fs.readFile(pinPath, 'utf8'))
    const asset = pin.assets['win32-x64']
    await fs.writeFile(join(cache, asset.name), Buffer.from('UEsDBBQAAAAAABKvTF1HeufYFAAAABQAAAAOAAAAY3VhLWRyaXZlci5leGVmaXh0dXJlIGRyaXZlciBieXRlc1BLAwQUAAAAAAASr0xdFkMaXhEAAAARAAAAEgAAAGN1YS1kcml2ZXItdWlhLmV4ZWZpeHR1cmUgVUlBIGJ5dGVzUEsBAhQDFAAAAAAAEq9MXUd659gUAAAAFAAAAA4AAAAAAAAAAAAAAIABAAAAAGN1YS1kcml2ZXIuZXhlUEsBAhQDFAAAAAAAEq9MXRZDGl4RAAAAEQAAABIAAAAAAAAAAAAAAIABQAAAAGN1YS1kcml2ZXItdWlhLmV4ZVBLBQYAAAAAAgACAHwAAACBAAAAAAA=', 'base64'))
    const env = { ...process.env, CRABOT_COMPUTER_USE_ASSET_DIR: cache }
    if (process.platform !== 'win32') {
      const commands = join(temporary, 'windows-commands')
      await fs.mkdir(commands)
      // Host fixture for PowerShell's ZIP operation; real Windows uses Expand-Archive.
      await fs.writeFile(join(commands, 'powershell.exe'), '#!/usr/bin/env python3\nimport os,zipfile\nzipfile.ZipFile(os.environ["CRABOT_COMPUTER_USE_ARCHIVE"]).extractall(".")\n', { mode: 0o755 })
      await fs.writeFile(join(commands, 'tar'), '#!/bin/sh\necho "GNU tar cannot extract ZIP" >&2\nexit 2\n', { mode: 0o755 })
      env.PATH = commands + ':' + process.env.PATH
    }
    asset.sha256 = createHash('sha256').update(await fs.readFile(join(cache, asset.name))).digest('hex')
    await fs.writeFile(pinPath, JSON.stringify(pin))
    const preload = join(temporary, 'windows-fixture.cjs')
    await fs.writeFile(preload, `Object.defineProperty(process, 'platform', { value: 'win32' }); Object.defineProperty(process, 'arch', { value: 'x64' });`)
    await run(process.execPath, ['--require', preload, join(product, 'scripts/prepare-computer-use.mjs')], {
      env, timeout: 10_000,
    })
    const name = `${pin.version}-win32-x64`
    const payload = join(product, '.computer-use-runtime', name)
    assert.equal(await fs.readFile(join(payload, 'cua-driver.exe'), 'utf8'), 'fixture driver bytes')
    assert.equal(await fs.readFile(join(payload, 'cua-driver-uia.exe'), 'utf8'), 'fixture UIA bytes')
    const ready = JSON.parse(await fs.readFile(join(payload, 'ready.json'), 'utf8'))
    assert.equal(ready.sha256, asset.sha256)
    assert.deepEqual(Object.keys(ready.files).sort(), ['cua-driver-uia.exe', 'cua-driver.exe'])
    assert.deepEqual(await fs.readdir(join(product, '.computer-use-runtime')), [name])
  } finally { await fs.rm(temporary, { recursive: true, force: true }) }
})
