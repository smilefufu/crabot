import test from 'node:test'
import assert from 'node:assert/strict'
import { Budget, nativeUsage } from './budget.mjs'
test('cached input and reasoning are subsets, never counted twice', () => {
  assert.deepEqual(nativeUsage({ prompt_tokens: 100, completion_tokens: 30,
    prompt_tokens_details: { cached_tokens: 70 }, completion_tokens_details: { reasoning_tokens: 20 } }),
  { input: 100, output: 30, cached: 70, reasoning: 20, total: 130 })
})
test('shared limit counts every attempt and keeps an in-flight reserve', () => {
  const b = new Budget(120_000_000, 109_999_900)
  b.begin('a'); assert.throws(() => b.begin('b'))
  b.finish('a', { prompt_tokens: 80, completion_tokens: 30 })
  assert.throws(() => b.begin('c'))
  assert.throws(() => b.finish('a', {}))
})
test('unaccounted failure closes admission instead of estimating it as zero', () => {
  const b = new Budget(120_000_000); b.begin('a')
  assert.throws(() => b.finish('a', undefined)); assert.throws(() => b.begin('b'))
  const c = new Budget(120_000_000); c.begin('a'); c.fail('a'); assert.throws(() => c.begin('b'))
})

test('invalid prior totals cannot disable the shared budget gate', () => {
  for (const prior of [NaN, Infinity, -1, 120_000_000]) assert.throws(() => new Budget(120_000_000, prior))
})

test('unknown usage reserve reduces admission without fabricating measured tokens', () => {
  const b = new Budget(120_000_000, 100_000_000, 10_000_000)
  b.begin('a'); b.finish('a', { prompt_tokens: 10, completion_tokens: 5 })
  assert.equal(b.used, 100_000_015); assert.equal(b.reserved, 10_000_000)
  assert.throws(() => b.begin('b'))
  for (const reserve of [NaN, Infinity, -1, 120_000_000]) assert.throws(() => new Budget(120_000_000, 0, reserve))
})
