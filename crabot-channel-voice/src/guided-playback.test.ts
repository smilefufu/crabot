import { afterEach, expect, it, vi } from 'vitest'
vi.mock('crabot-shared', () => ({ synthesizeAudio: vi.fn(async () => Buffer.alloc(960)) }))
import { GuidedPlayback } from './guided-playback.js'
import { synthesizeAudio } from 'crabot-shared'
afterEach(() => vi.useRealTimers())

const connection = { provider_id: 'fixture', format: 'mlx-audio-http' as const, endpoint: 'http://fixture', model_id: 'fixture' }
it('does not authorize capture for sent bytes or an incomplete playback receipt', async () => {
  let sent = 0, ended = 0
  const player = new GuidedPlayback(connection, 'fixed public prompt', Date.now() + 5000, {
    valid() {}, start() {}, audio: (_, pcm) => { sent += pcm.length / 2 }, end: samples => { ended = samples },
  })
  await vi.waitFor(() => expect(ended).toBe(480))
  expect(sent).toBe(480)
  player.receipt('completed', 479)
  await expect(player.done).rejects.toThrow('未完整播放')
})
it('current-context loss cancels a management prompt and cannot complete it later', async () => {
  const player = new GuidedPlayback(connection, 'fixed public prompt', Date.now() + 5000, { valid() { throw new Error('background') }, start() {}, audio() {}, end() {} })
  await expect(player.done).rejects.toThrow()
  player.receipt('completed', 480)
  await expect(player.done).rejects.toThrow()
})
it('invalid PCM never starts a prompt or authorizes capture', async () => {
  vi.mocked(synthesizeAudio).mockResolvedValueOnce(Buffer.alloc(1))
  const start = vi.fn(), player = new GuidedPlayback(connection, 'fixed public prompt', Date.now() + 5000, { valid() {}, start, audio() {}, end() {} })
  await expect(player.done).rejects.toThrow(); expect(start).not.toHaveBeenCalled()
})
it('a stalled first audio fails within five seconds and late completion cannot authorize capture', async () => {
  vi.useFakeTimers()
  vi.mocked(synthesizeAudio).mockImplementationOnce(async (_connection, _text, signal) => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')))))
  const start = vi.fn(), player = new GuidedPlayback(connection, 'fixed public prompt', Date.now() + 60000, { valid() {}, start, audio() {}, end() {} })
  const failure = expect(player.done).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(5000); await failure
  player.receipt('completed', 480); expect(start).not.toHaveBeenCalled()
})
