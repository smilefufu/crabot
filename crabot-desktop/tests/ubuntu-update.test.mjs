import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareUbuntuUpdate } from '../dist/ubuntu-update.js'

const linux = { skip: process.platform !== 'linux' || process.getuid?.() === 0 }
test('failed complete program verification prevents even native update inspection', linux, async () => {
  let verified = 0
  await assert.rejects(prepareUbuntuUpdate({ guiRoot: '/never-run/unsigned-gui' }, {
    signal: new AbortController().signal,
    verifyPrograms: async () => { verified++; throw Object.assign(new Error('Fixture verification rejected'), { code: 'CRABOT_CORE_INTEGRITY' }) },
  }), { code: 'CRABOT_CORE_INTEGRITY' })
  assert.equal(verified, 1)
})
test('a cancelled update never verifies programs, starts a helper or asks Polkit', linux, async () => {
  const abort = new AbortController(); abort.abort(); let verified = 0
  await assert.rejects(prepareUbuntuUpdate({}, { signal: abort.signal, verifyPrograms: async () => { verified++; throw new Error('Must not verify') } }), { name: 'AbortError' })
  assert.equal(verified, 0)
})
