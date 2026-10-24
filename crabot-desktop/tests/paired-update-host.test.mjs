import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { createPairedUpdateHost } from '../dist/paired-update-host.js'

function options(pinnedPublicKeys) {
  return new Proxy({ pinnedPublicKeys }, { get: (target, name) => {
    if (name === 'pinnedPublicKeys') return target.pinnedPublicKeys
    assert.fail('A disabled/uninitialized host must not read capabilities: ' + String(name))
  } })
}
test('no pinned release root disables the complete-root host without disk, network or OS capabilities', async () => {
  assert.equal(await createPairedUpdateHost(options([])), null)
})
test('an invalid trust root rejects before installation, network or target code access', async () => {
  await assert.rejects(createPairedUpdateHost(options(['not-a-public-key'])), { code: 'CRABOT_DESKTOP_RELEASE_SIGNATURE' })
})
test('closing before the first check cancels initialization without starting any work', async () => {
  const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const driver = await createPairedUpdateHost(options([key]))
  driver.close(); driver.close()
  await assert.rejects(driver.check(() => {}), { name: 'AbortError' })
  await assert.rejects(driver.install({ kind: 'paired', version: '1.2.4' }), { name: 'AbortError' })
})
