// Synthetic update-preservation data belongs after ordinary fresh initialization.
// Never seed unmarked user data or bypass the actual controller's ready result.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
async function startPairedUpdateSource(controller, dataDir) {
  const state = await controller.start()
  assert.equal(state.phase, 'ready')
  fs.writeFileSync(path.join(dataDir, 'update-fixture-preserved.txt'), 'preserved across the actual pair handoff\n', { flag: 'wx', mode: 0o600, flush: true })
  return state
}
module.exports = { startPairedUpdateSource }
