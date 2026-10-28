import test from 'node:test'
import assert from 'node:assert/strict'

test('shared module-start probe preserves the existing Core producer identity for the current process', async () => {
  const { probeProcessStartIdentity } = await import('../module-process-start.cjs')
  const core = await import('../../../crabot-core/dist/module-runtime-registry.js')
  const expected = await core.probeProcessStartIdentity(process.pid)
  assert.equal(typeof expected, 'string')
  assert.equal(await probeProcessStartIdentity(process.pid), expected)
  assert.equal(await probeProcessStartIdentity(2_147_483_647), null)
})
