import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
const root = import.meta.dirname
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
for (const [name, expected] of Object.entries(manifest.inputs)) {
  const file = path.resolve(root, name)
  assert(file.startsWith(root + path.sep), 'Manifest path escapes baseline')
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), expected, name)
}
const result = JSON.parse(fs.readFileSync(path.join(root, 'results.json'), 'utf8'))
assert.equal(result.rows.length, 30)
assert.equal(new Set(result.rows.map(row => row.task)).size, 30)
assert.equal(result.rows.filter(row => row.source === 'original30_20261110').length, 29)
assert.equal(result.rows.filter(row => row.source === 'explicitly_authorized_technical_retest_20261111').length, 1)
const scale = Math.max(...result.rows.map(row => (row.score.split('.')[1] ?? '').length))
const unit = 10n ** BigInt(scale)
const number = text => {
  assert.match(text, /^\d+(?:\.\d+)?$/)
  const [integer, fraction = ''] = text.split('.')
  return BigInt(integer) * unit + BigInt(fraction.padEnd(scale, '0'))
}
const mean = rows => {
  const numerator = rows.reduce((sum, row) => sum + number(row.score), 0n) * 100n
  const denominator = BigInt(rows.length) * unit
  const rounded = (numerator * 2n + denominator) / (denominator * 2n)
  return `${rounded / 100n}.${String(rounded % 100n).padStart(2, '0')}`
}
for (const subset of ['code', 'web', 'office']) {
  const rows = result.rows.filter(row => row.subset === subset)
  assert.equal(rows.length, 10)
  assert.equal(mean(rows), result.category_scores[subset])
}
for (const row of result.rows) {
  assert(number(row.score) >= 0n && number(row.score) <= 100n * unit)
  assert.match(row.score_sha256, /^[a-f0-9]{64}$/)
  assert.match(row.terminal_audit_sha256, /^[a-f0-9]{64}$/)
}
assert.equal(mean(result.rows), result.overall)
assert.equal(result.causal_improvement_claim, false)
console.log(`Verified ${Object.keys(manifest.inputs).length} payload hashes, 30 result records, and exact-decimal mean ${result.overall}.`)
