import test from 'node:test'
import assert from 'node:assert/strict'
import { workspaceMetadataWithoutSecurity } from '../workspace-windows-metadata.mjs'
const encode = parts => Buffer.concat(parts.flatMap(value => [Buffer.from(value.length + ':'), value]))
test('non-security comparison retains raw attributes and binary EAs independently from ACL text', () => {
  const fields = [Buffer.from('32'), Buffer.from('O:LAD:(A;;FA;;;LA)'), Buffer.from([0, 58, 255])]
  const before = workspaceMetadataWithoutSecurity(encode(fields))
  assert.deepEqual(before, workspaceMetadataWithoutSecurity(encode([fields[0], Buffer.from('O:LAD:(A;ID;FA;;;LA)'), fields[2]])))
  assert.notDeepEqual(before, workspaceMetadataWithoutSecurity(encode([Buffer.from('33'), fields[1], fields[2]])))
  assert.notDeepEqual(before, workspaceMetadataWithoutSecurity(encode([fields[0], fields[1], Buffer.from([0, 58, 254])])))
})
test('malformed or extra metadata is never accepted as equal non-security evidence', () => {
  for (const input of [undefined, Buffer.from('1:x'), Buffer.from('01:x0:0:'), Buffer.from('999:x0:0:'), Buffer.from('1:x0:0:0:')]) {
    assert.throws(() => workspaceMetadataWithoutSecurity(input))
  }
})
