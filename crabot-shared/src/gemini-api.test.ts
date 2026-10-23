import { test } from 'node:test'
import assert from 'node:assert/strict'
import { geminiApiHeaders, geminiApiUrl, geminiModelId } from './gemini-api.js'

test('Gemini URLs preserve gateway prefix and explicit native versions', () => {
  assert.equal(geminiApiUrl('https://gateway.example/antigravity/'), 'https://gateway.example/antigravity/v1beta/models')
  assert.equal(geminiApiUrl('https://gateway.example/antigravity/v1beta'), 'https://gateway.example/antigravity/v1beta/models')
  assert.equal(geminiApiUrl('https://gateway.example/v1', 'models/gemini-test'), 'https://gateway.example/v1/models/gemini-test:streamGenerateContent?alt=sse')
})
test('Gemini credentials stay in the host-appropriate Header', () => {
  assert.deepEqual(geminiApiHeaders('https://generativelanguage.googleapis.com', 'key'), { 'x-goog-api-key': 'key' })
  assert.deepEqual(geminiApiHeaders('https://gateway.example', 'key'), { Authorization: 'Bearer key' })
})
test('Gemini rejects credential-bearing endpoint URLs and path-like model IDs', () => {
  for (const url of ['https://example.test?key=secret', 'https://user:pass@example.test', 'file:///tmp/data', 'https://example.test#fragment']) assert.throws(() => geminiApiUrl(url))
  for (const id of ['', '..', '../secret', 'models/models/a', 'a?key=x', 'a#x']) assert.throws(() => geminiModelId(id))
  assert.equal(geminiModelId('models/gemini-test'), 'gemini-test')
})
