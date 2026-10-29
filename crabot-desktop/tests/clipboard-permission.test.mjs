import test from 'node:test'
import assert from 'node:assert/strict'
import { allowsDesktopClipboardWrite } from '../dist/window-security.js'

function fixture() {
  const frame = { parent: null, origin: 'app://crabot', url: 'app://crabot/channels/new/channel-slack/local-cli', processId: 1, routingId: 2 }
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false }
  const details = { isMainFrame: true, requestingUrl: frame.url }
  return { frame, contents, details }
}
test('the trusted top-level desktop page may write to the clipboard', () => {
  const { contents, details } = fixture()
  assert.equal(allowsDesktopClipboardWrite(contents, contents, 'clipboard-sanitized-write', details), true)
})
test('clipboard reads and unrelated browser permissions remain denied', () => {
  const { contents, details } = fixture()
  for (const permission of ['clipboard-read', 'deprecated-sync-clipboard-read', 'media', 'display-capture', 'openExternal', 'unknown']) {
    assert.equal(allowsDesktopClipboardWrite(contents, contents, permission, details), false)
  }
})
test('foreign windows, subframes, non-app documents and workers cannot gain clipboard access', () => {
  const { contents, details } = fixture()
  for (const [caller, expected, request] of [
    [{ ...contents, id: 2 }, contents, details], [null, contents, details], [contents, undefined, details],
    [contents, contents, { ...details, isMainFrame: false }],
    [contents, contents, { ...details, requestingUrl: 'https://untrusted.example/' }],
    [contents, contents, { ...details, requestingUrl: undefined }],
  ]) assert.equal(allowsDesktopClipboardWrite(caller, expected, 'clipboard-sanitized-write', request), false)
  contents.mainFrame.origin = 'https://untrusted.example'
  assert.equal(allowsDesktopClipboardWrite(contents, contents, 'clipboard-sanitized-write', details), false)
})

test('closed windows are rejected without touching their destroyed main frame', () => {
  const { contents, details } = fixture()
  contents.isDestroyed = () => true
  Object.defineProperty(contents, 'mainFrame', { get() { throw new Error('Object has been destroyed') } })
  assert.equal(allowsDesktopClipboardWrite(contents, contents, 'clipboard-sanitized-write', details), false)
})
