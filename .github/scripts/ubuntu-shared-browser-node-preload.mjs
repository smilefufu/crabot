// CI-only counterfactual: change one Python probe environment value, never package bytes or sandbox flags.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
assert.equal(process.platform, 'linux'); assert.equal(process.env.CRABOT_CI_BROWSER_NODE_DIAGNOSIS, '1')
const original = childProcess.spawn
childProcess.spawn = function(command, args, options) {
  if (args?.[0] === '-I' && args[1] === '-B' && path.basename(args[2]) === 'browser-probe.py') {
    const core = args[3], directory = JSON.parse(readFileSync(path.join(core, 'scrapling-runtime.json'), 'utf8')).directory
    const runtime = path.join(core, directory), ready = JSON.parse(readFileSync(path.join(runtime, 'ready.json'), 'utf8'))
    const node = realpathSync(path.resolve(runtime, ready.node))
    assert.equal(node, realpathSync(path.join(core, '.product-runtime/node/bin/node')))
    options = { ...options, env: { ...options.env, PLAYWRIGHT_NODEJS_PATH: node } }
    console.error('CRABOT_CI_SHARED_BROWSER_NODE_OVERRIDE')
  }
  return original.call(this, command, args, options)
}
syncBuiltinESMExports()
