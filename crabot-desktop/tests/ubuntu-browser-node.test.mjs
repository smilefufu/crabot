import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('Ubuntu installation probe uses the bundled shared Node when private browser Node is absent', { skip: process.platform === 'win32' }, async t => {
  const core = await fs.mkdtemp(path.join(tmpdir(), 'crabot-probe-node-'))
  t.after(() => fs.rm(core, { recursive: true, force: true }))
  const directory = '.scrapling-runtime-test-' + 'a'.repeat(16) + '-' + 'b'.repeat(8)
  const runtime = path.join(core, directory), packages = path.join(runtime, 'packages/playwright')
  const node = path.join(core, '.product-runtime/node/bin/node')
  await fs.mkdir(packages, { recursive: true }); await fs.mkdir(path.dirname(node), { recursive: true })
  await fs.writeFile(node, 'fixture shared Node')
  await fs.writeFile(path.join(core, 'scrapling-runtime.json'), JSON.stringify({ directory }))
  await fs.writeFile(path.join(core, 'product-runtime.json'), JSON.stringify({ browser: directory + '/chromium-launcher' }))
  await fs.writeFile(path.join(runtime, 'ready.json'), JSON.stringify({ node: '../.product-runtime/node/bin/node' }))
  await fs.writeFile(path.join(packages, '__init__.py'), '')
  // Stop at the driver boundary: the real packaged sandbox/network checks run in native CI.
  await fs.writeFile(path.join(packages, 'sync_api.py'), `import os, pathlib, sys
def sync_playwright():
    expected = pathlib.Path(sys.argv[1]) / '.product-runtime/node/bin/node'
    assert pathlib.Path(os.environ['PLAYWRIGHT_NODEJS_PATH']).resolve() == expected.resolve()
    assert expected.is_file()
    print('BUNDLED_SHARED_NODE_SELECTED')
    raise SystemExit(0)
`)
  const probe = fileURLToPath(new URL('../native/ubuntu/browser-probe.py', import.meta.url))
  for (const inherited of [undefined, '/foreign/node']) {
    const env = { ...process.env }; delete env.PLAYWRIGHT_NODEJS_PATH
    if (inherited) env.PLAYWRIGHT_NODEJS_PATH = inherited
    const result = spawnSync('python3', ['-I', '-B', probe, core, 'http://127.0.0.1:1/' + '0'.repeat(64)], { env, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /BUNDLED_SHARED_NODE_SELECTED/)
  }
})
