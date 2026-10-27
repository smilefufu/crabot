import test from 'node:test'
import assert from 'node:assert/strict'
import { DesktopDirectorySelectionSchema } from '../dist/index.js'

test('native directory selection is nullable and accepts only bounded absolute portable path syntax', () => {
  for (const value of [null, '/目录/with spaces', String.raw`C:\Users\folder`, String.raw`\\server\share\folder`]) {
    assert.equal(DesktopDirectorySelectionSchema.parse(value), value)
  }
  for (const value of ['', 'relative/path', 'C:relative', 'https://untrusted/path', '/bad\0path', '/'+ 'x'.repeat(32768), { path: '/folder' }, ['/folder']]) {
    assert.equal(DesktopDirectorySelectionSchema.safeParse(value).success, false)
  }
})
