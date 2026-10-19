import { afterEach, expect, it, vi } from 'vitest'
import { appendVoiceText, finishVoicePlayback } from '../../src/manager/voice-output-flow.js'
afterEach(() => vi.useRealTimers())

it('waits for actual completion beyond the end acceptance', async () => {
  vi.useFakeTimers()
  let completed = false, delivered = false
  const send = vi.fn(async () => ({ accepted: true as const }))
  const pending = finishVoicePlayback(send, async id => completed
    ? { playback_id: id, status: 'completed', sent_at: new Date().toISOString(), played_samples: 4_320_000 }
    : { playback_id: id, status: 'active' }, 'original')
  void pending.then(() => { delivered = true })
  await vi.advanceTimersByTimeAsync(1500); expect(delivered).toBe(false)
  completed = true; await vi.advanceTimersByTimeAsync(500)
  expect((await pending).played_samples).toBe(4_320_000)
  expect(send).toHaveBeenCalledTimes(1)
})

it('retries only an explicit nonacceptance with the identical identity and sequence', async () => {
  vi.useFakeTimers()
  const events: any[] = [], text = '🙂'.repeat(300)
  let reject = true
  const send = async (event: any) => {
    events.push(event)
    if (reject) { reject = false; return { accepted: false as const, code: 'VOICE_OUTPUT_BACKPRESSURE' as const } }
    return { accepted: true as const }
  }
  const pending = appendVoiceText(send, async id => ({ playback_id: id, status: 'active' }), 'same-id', 0, text)
  await vi.advanceTimersByTimeAsync(500)
  expect(await pending).toBe(3)
  expect(events[0]).toEqual(events[1])
  expect(events.slice(1).map(x => x.text).join('')).toBe(text)
  expect(events.slice(1).map(x => x.sequence)).toEqual([0, 1, 2])
})

it('unknown completion stops immediately and never resends the output', async () => {
  const send = vi.fn(async () => ({ accepted: true as const }))
  await expect(finishVoicePlayback(send, async id => ({ playback_id: id, status: 'unknown' }), 'original')).rejects.toThrow('unknown')
  expect(send).toHaveBeenCalledTimes(1)
})

it('cancellation releases a backpressured consumer without waiting for a new provider chunk', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const send = vi.fn(async () => ({ accepted: false as const, code: 'VOICE_OUTPUT_BACKPRESSURE' as const }))
  const pending = appendVoiceText(send, async id => ({ playback_id: id, status: 'active' }), 'original', 0, '正文。', controller.signal)
  const check = expect(pending).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(10); controller.abort(); await check
  expect(send).toHaveBeenCalledTimes(1)
})
