import test from 'node:test'
import assert from 'node:assert/strict'
import identity from '../../scripts/lib/process-identity.cjs'
import { observeDesktopResources } from '../../.github/scripts/desktop-resources.mjs'
test('OS RSS observation samples the actual owned test process without starting a business MM', async () => {
  const actual = identity.inspectProcess(process.pid), sample = await observeDesktopResources([actual])
  assert.ok(sample.rss_sum_bytes > 0)
  assert.ok(sample.sampled_processes >= 1); assert.ok(sample.observed_processes >= sample.sampled_processes)
  assert.equal(sample.platform, process.platform); assert.equal(sample.arch, process.arch)
  assert.equal(sample.scope, 'observable-owned-descendants-of-confirmed-product-roots')
  assert.equal(sample.metric, 'sum-of-process-rss-shared-pages-may-repeat')
})
test('a stale or foreign resource root cannot select other user processes for observation', async () => {
  const actual = identity.inspectProcess(process.pid)
  await assert.rejects(observeDesktopResources([null]), /roots changed/)
  await assert.rejects(observeDesktopResources([{ ...actual, started: 'replaced' }]), /roots changed/)
  await assert.rejects(observeDesktopResources([{ ...actual, owner: 'another-user' }]), /roots changed/)
})
