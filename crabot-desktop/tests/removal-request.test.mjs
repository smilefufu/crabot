import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { removalHostArgument, readRemovalHostRequest } from '../dist/removal-request.js'
const request = { installRoot: path.resolve('安装 空间'), operationId: randomUUID(), existing: false }
test('fixed removal request roundtrips the locator without expanding ordinary startup arguments', () => {
  assert.deepEqual(readRemovalHostRequest([process.execPath, removalHostArgument(request)]), request)
  assert.equal(readRemovalHostRequest([process.execPath, '--background']), undefined)
  assert.deepEqual(readRemovalHostRequest([process.execPath, removalHostArgument({ ...request, existing: true })]), { ...request, existing: true })
})
for (const value of [null, [], { ...request, command: 'anything' }, { ...request, installRoot: '../elsewhere' }, { ...request, existing: 1 }, { ...request, operationId: '../file' }]) test('removal locator rejects an invalid shape: ' + JSON.stringify(value), () => {
  assert.throws(() => removalHostArgument(value), { code: 'CRABOT_DESKTOP_REMOVAL' })
})
for (const args of [
  [process.execPath, '--crabot-removal-host'], [process.execPath, '--crabot-removal-host=%%%'],
  [process.execPath, removalHostArgument(request), '--background'],
  [process.execPath, removalHostArgument(request), removalHostArgument(request)],
  [process.execPath, '--crabot-removal-host=' + Buffer.from('{"command":"remove"}').toString('base64url')],
]) test('private removal invocation rejects extra or malformed arguments: ' + args.length, () => {
  assert.throws(() => readRemovalHostRequest(args), { code: 'CRABOT_DESKTOP_REMOVAL' })
})
