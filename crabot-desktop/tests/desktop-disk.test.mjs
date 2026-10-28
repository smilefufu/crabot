import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { startDesktopDiskObservation } from '../../.github/scripts/desktop-disk.mjs'
test('disk observation reads actual disposable filesystem availability with explicit volume and timing limits', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crabot-disk-observation-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const observation = await startDesktopDiskObservation(directory)
  try {
    await writeFile(path.join(directory, 'fixture'), Buffer.alloc(8 * 1024 * 1024, 17))
    await new Promise(resolve => setTimeout(resolve, 1100))
  } finally {
    const stopped = observation.stop()
    assert.equal(observation.stop(), stopped, 'stopping is idempotent and must not start another sampler')
    const sample = await stopped
    assert.ok(sample.elapsed_ms >= 1100); assert.ok(sample.max_observed_sample_gap_ms > 0)
    assert.equal(sample.requested_interval_ms, 1000)
    assert.ok(sample.samples >= 3); assert.equal(sample.failed_samples, 0)
    assert.ok(sample.minimum_available_bytes <= sample.baseline_available_bytes)
    assert.ok(sample.minimum_available_bytes <= sample.final_available_bytes)
    assert.equal(sample.max_observed_available_drop_bytes, sample.baseline_available_bytes - sample.minimum_available_bytes)
    assert.equal(sample.scope, 'filesystem-containing-disposable-fixture')
    assert.equal(sample.metric, 'sampled-volume-availability-drop')
    assert.match(sample.limitations, /not-attributed.*may-be-missed/)
    assert.ok(!JSON.stringify(sample).includes(directory))
  }
})
test('an absent fixture cannot manufacture a successful disk observation', async () => {
  await assert.rejects(startDesktopDiskObservation(path.join(os.tmpdir(), 'crabot-missing-disk-fixture-' + process.pid)), { code: 'ENOENT' })
})
