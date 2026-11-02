// Read-only diagnosis of the exact immutable installer; never registers programs or starts MM.
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.platform, 'linux')
const bundle = path.resolve(process.argv[2], 'ubuntu-native'), core = path.join(bundle, 'offline/core')
const require = createRequire(path.join(core, 'package.json'))
const runtime = require('./scripts/lib/product-runtime.cjs').loadProductRuntime(core, { required: true, full: true })
const script = `
import json, os, runpy, sys
from pathlib import Path
core, probe, mode = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
directory = json.loads((core / 'scrapling-runtime.json').read_text())['directory']
runtime = core / directory
ready = json.loads((runtime / 'ready.json').read_text())
sys.path.insert(0, str(runtime / 'packages'))
os.environ.pop('PLAYWRIGHT_NODEJS_PATH', None)
from playwright._impl._driver import compute_driver_executable
default = Path(compute_driver_executable()[0])
assert not default.exists(), 'The proposed missing-driver diagnosis does not match this package'
if mode == 'original':
    sys.argv = [probe, str(core), 'http://127.0.0.1:1/' + '0' * 64]
    try:
        runpy.run_path(probe, run_name='__main__')
        raise AssertionError('Original probe unexpectedly succeeded')
    except FileNotFoundError as error:
        assert Path(error.filename) == default
        print(json.dumps({'original_probe': 'FileNotFoundError', 'missing_driver': str(default.relative_to(core))}))
else:
    node = (runtime / ready['node']).resolve()
    assert node.is_file()
    os.environ['PLAYWRIGHT_NODEJS_PATH'] = str(node)
    assert Path(compute_driver_executable()[0]) == node
    from playwright.sync_api import sync_playwright
    with sync_playwright() as engine:
        assert engine.chromium.name == 'chromium'
    print(json.dumps({'shared_node_driver_ready': True, 'shared_node': str(node.relative_to(core))}))
`
for (const mode of ['original', 'shared']) {
  const stdout = execFileSync(runtime.executables.python, ['-I', '-B', '-c', script, core, path.join(bundle, 'browser-probe.py'), mode],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })
  console.log('CRABOT_UBUNTU_BROWSER_NODE_DIAGNOSIS ' + stdout.trim())
}
