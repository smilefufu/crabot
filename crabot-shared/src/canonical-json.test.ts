import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalizeJson, sha256CanonicalJson } from './canonical-json.js'

test('canonicalizeJson uses RFC 8785 object key ordering and preserves arrays', () => {
  assert.equal(canonicalizeJson({ z: [3, { b: true, a: 'x' }], a: null }), '{"a":null,"z":[3,{"a":"x","b":true}]}')
  assert.equal(sha256CanonicalJson({ b: 2, a: 1 }), sha256CanonicalJson({ a: 1, b: 2 }))
})

test('canonicalizeJson orders object keys by UTF-16 code units', () => {
  assert.equal(canonicalizeJson({ '\u{1f600}': 1, '\ufffd': 2 }), '{"😀":1,"�":2}')
})

test('canonicalizeJson uses ECMAScript JSON number and string escaping rules', () => {
  assert.equal(canonicalizeJson({ n: 1e-7, zero: -0, text: 'line\n\t"\\\u0000' }), '{"n":1e-7,"text":"line\\n\\t\\\"\\\\\\u0000","zero":0}')
})

test('canonicalizeJson rejects non-I-JSON values, sparse arrays, and unpaired surrogates', () => {
  for (const value of [NaN, Infinity, -Infinity, undefined, BigInt(1), [undefined], [, 1], { x: undefined }, '\ud800', { '\udc00': 1 }]) {
    assert.throws(() => canonicalizeJson(value), /canonical JSON/i)
  }
})
