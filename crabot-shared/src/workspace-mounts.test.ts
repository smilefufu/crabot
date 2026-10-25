import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLinuxMounts } from './workspace-mounts.js'

test('Linux mount boundaries use the actual mount point, decode octal paths, and allow variable optional fields', () => {
  const value = '36 35 98:0 /source /project/mounted\\040space rw,noatime shared:1 master:2 unknown:value - ext4 /dev/root rw\n37 35 98:0 /other /project/escaped\\134name rw - ext4 /dev/root rw\n'
  const mounts = parseLinuxMounts(value)
  assert.equal(mounts.has('/project/mounted space'), true)
  assert.equal(mounts.has('/project/escaped\\name'), true)
  assert.equal(mounts.has('/source'), false)
})
test('unverifiable mount metadata cannot masquerade as an empty safe namespace', () => {
  for (const text of ['', 'malformed', '36 35 98:0 /src relative rw - ext4 /dev/root rw', '36 35 98:0 /src /bad\\escape rw - ext4 /dev/root rw']) {
    assert.throws(() => parseLinuxMounts(text), { code: 'WORKSPACE_MOUNTS_UNAVAILABLE' })
  }
})
