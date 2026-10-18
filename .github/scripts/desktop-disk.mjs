// CI-only filesystem observation. This cannot attribute shared-volume writes or
// capture peaks shorter than its sampling interval; it never measures file bodies.
import { statfs } from 'node:fs/promises'
import os from 'node:os'
export async function startDesktopDiskObservation(directory) {
  const available = async () => {
    const value = await statfs(directory, { bigint: true })
    const bytes = Number(value.bavail * value.bsize)
    if (!Number.isSafeInteger(bytes) || bytes < 0 || value.bsize <= 0n) throw new Error('Invalid filesystem availability sample')
    return bytes
  }
  const baseline = await available(), started = performance.now()
  let previousSample = started, maximumGap = 0
  let minimum = baseline, last = baseline, samples = 1, failed = 0, pending = null, stopped
  const sample = async () => {
    const now = performance.now()
    maximumGap = Math.max(maximumGap, now - previousSample); previousSample = now
    try { last = await available(); minimum = Math.min(minimum, last); samples++ }
    catch { failed++ }
  }
  const interval = setInterval(() => {
    if (!pending) pending = sample().finally(() => { pending = null })
  }, 1000)
  interval.unref()
  return { stop: () => stopped ??= (async () => {
    clearInterval(interval)
    await pending
    await sample()
    return { platform: process.platform, arch: process.arch, os_release: os.release(), requested_interval_ms: 1000, elapsed_ms: Math.round(performance.now() - started), max_observed_sample_gap_ms: Math.ceil(maximumGap),
      samples, failed_samples: failed, baseline_available_bytes: baseline, minimum_available_bytes: minimum,
      final_available_bytes: last, max_observed_available_drop_bytes: baseline - minimum,
      scope: 'filesystem-containing-disposable-fixture', metric: 'sampled-volume-availability-drop',
      limitations: 'shared-volume-writes-not-attributed-and-subsecond-peaks-may-be-missed' }
  })() }
}
