import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { join, dirname, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { ensureProductAgentVenv } = require('../product-python-env.cjs')

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crabot-product-agent-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const python = process.platform === 'win32' ? 'python.exe' : 'bin/python3.12'
  const home = join(root, 'product/python')
  mkdirSync(dirname(join(home, python)), { recursive: true })
  writeFileSync(join(home, python), 'immutable interpreter')
  const runtime = {
    root, pythonHome: home, pathEntries: [join(root, 'product/bin')],
    executables: { uv: join(root, 'product/uv'), bash: join(root, 'product/bash') },
    seedWheels: [join(root, 'product/pip.whl')],
    manifest: { python_home: 'product/python', versions: { python: '3.12.12' }, files: {
      ['product/python/' + python]: { size: 21, sha256: createHash('sha256').update('immutable interpreter').digest('hex') },
    } },
  }
  const data = join(root, '实例 数据')
  mkdirSync(data)
  const binary = join(data, 'agent-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    if (args[0] === 'venv') { mkdirSync(dirname(binary), { recursive: true }); writeFileSync(binary, 'venv interpreter') }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { root, runtime, data, binary, calls, spawn }
}

test('offline bootstrap uses a stable base and explicit wheel files, leaving product bytes untouched', t => {
  const f = fixture(t)
  const result = ensureProductAgentVenv(f.runtime, f.data, f.spawn)
  assert.equal(result.split(delimiter)[0], dirname(f.binary))
  assert.equal(f.calls.length, 3)
  assert.ok(f.calls[0].args.includes('--offline'))
  assert.ok(f.calls[0].args.includes('--no-python-downloads'))
  assert.ok(f.calls[0].args.some(arg => arg.includes('runtime-bases')))
  assert.ok(f.calls[1].args.includes('--no-index'))
  assert.ok(f.calls[1].args.includes(f.runtime.seedWheels[0]))
  assert.equal(readFileSync(join(f.runtime.pythonHome, process.platform === 'win32' ? 'python.exe' : 'bin/python3.12'), 'utf8'), 'immutable interpreter')
})

test('an app relocation or compatible update retains the existing environment and base', t => {
  const f = fixture(t)
  ensureProductAgentVenv(f.runtime, f.data, f.spawn)
  const marker = readFileSync(join(f.data, 'agent-venv/.crabot-runtime.json'), 'utf8')
  f.calls.length = 0
  rmSync(f.runtime.pythonHome, { recursive: true })
  f.runtime.root = join(f.root, 'moved app')
  ensureProductAgentVenv(f.runtime, f.data, f.spawn)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].command, f.binary)
  assert.equal(readFileSync(join(f.data, 'agent-venv/.crabot-runtime.json'), 'utf8'), marker)
})

test('copied Python aliases continue to reference the stable base after the app is removed', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t)
  const alias = 'product/python/bin/python3'
  symlinkSync('python3.12', join(f.root, alias))
  f.runtime.manifest.files[alias] = f.runtime.manifest.files['product/python/bin/python3.12']
  ensureProductAgentVenv(f.runtime, f.data, f.spawn)
  const owned = JSON.parse(readFileSync(join(f.data, 'agent-venv/.crabot-runtime.json'), 'utf8'))
  const target = join(f.data, 'runtime-bases', 'python-' + owned.base_id, 'bin/python3')
  rmSync(f.runtime.pythonHome, { recursive: true })
  assert.ok(realpathSync(target).startsWith(join(f.data, 'runtime-bases')))
  assert.equal(readFileSync(target, 'utf8'), 'immutable interpreter')
})

test('unknown old environments and a Python minor-version change preserve dependencies for explicit migration', t => {
  const f = fixture(t)
  mkdirSync(dirname(f.binary), { recursive: true })
  writeFileSync(f.binary, 'user environment')
  assert.throws(() => ensureProductAgentVenv(f.runtime, f.data, f.spawn), { code: 'CRABOT_PYTHON_ENV_MIGRATION_REQUIRED' })
  assert.equal(readFileSync(f.binary, 'utf8'), 'user environment')
  writeFileSync(join(f.data, 'agent-venv/.crabot-installing.json'), JSON.stringify({ schema_version: 1, pid: 0 }))
  assert.throws(() => ensureProductAgentVenv(f.runtime, f.data, f.spawn), { code: 'CRABOT_PYTHON_ENV_MIGRATION_REQUIRED' })
  assert.equal(readFileSync(f.binary, 'utf8'), 'user environment')
  rmSync(join(f.data, 'agent-venv'), { recursive: true })
  ensureProductAgentVenv(f.runtime, f.data, f.spawn)
  f.runtime.manifest.versions.python = '3.13.1'
  assert.throws(() => ensureProductAgentVenv(f.runtime, f.data, f.spawn), { code: 'CRABOT_PYTHON_ENV_MIGRATION_REQUIRED' })
  assert.ok(existsSync(f.binary))
  writeFileSync(join(f.data, 'agent-venv/.crabot-runtime.json'), 'null')
  assert.throws(() => ensureProductAgentVenv(f.runtime, f.data, f.spawn), { code: 'CRABOT_PYTHON_ENV_MIGRATION_REQUIRED' })
})

test('an offline seed failure removes only the newly created venv and preserves stable bases', t => {
  const f = fixture(t)
  assert.throws(() => ensureProductAgentVenv(f.runtime, f.data, () => ({ status: 1, stderr: 'offline seed failed' })), /offline seed failed/)
  assert.equal(existsSync(join(f.data, 'agent-venv')), false)
  assert.equal(existsSync(join(f.data, 'runtime-bases')), true)
  assert.equal(existsSync(f.runtime.pythonHome), true)
})
