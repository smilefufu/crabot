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

test('a descendant exiting between identity capture and RSS sampling is reported as partial', { timeout: 20000 }, async t => {
  const { spawn } = await import('node:child_process'), { once } = await import('node:events')
  const child = spawn(process.execPath, ['-e', 'process.send({ready:true});setTimeout(()=>process.exit(0),10000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill() })
  await once(child, 'message')
  const root = identity.inspectProcess(process.pid), descendant = identity.inspectProcess(child.pid)
  const exited = once(child, 'exit'); child.kill(); await exited
  const inspect = identity.inspectProcess; let captured = false
  t.mock.method(identity, 'listProcessIds', () => [root.pid, descendant.pid])
  t.mock.method(identity, 'inspectProcess', pid => {
    if (pid === descendant.pid && !captured) { captured = true; return descendant }
    return inspect(pid)
  })
  const sample = await observeDesktopResources([root])
  assert.equal(sample.observed_processes, 2); assert.equal(sample.sampled_processes, 1)
  assert.equal(sample.complete_for_observed_tree, false); assert.ok(sample.rss_sum_bytes > 0)
})
