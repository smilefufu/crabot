import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('crabot-shared', () => ({ synthesizeAudio: vi.fn(async () => Buffer.alloc(960)) }))
import { synthesizeAudio } from 'crabot-shared'
import { ReplyPlayback, SentenceBuffer } from './reply-playback.js'

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('bounded long voice playback', () => {
  it('preserves leading line breaks without synthesizing a whitespace-only sentence', () => {
    const buffer = new SentenceBuffer()
    expect(buffer.append('\n你好。\n')).toEqual(['\n你好。'])
    expect(buffer.append('下一句。')).toEqual(['\n下一句。'])
  })
  it('splits long unpunctuated Unicode without losing or repeating text', () => {
    const buffer = new SentenceBuffer(), source = '🙂123.45甲乙丙'.repeat(80)
    const chunks = [...buffer.append(source), ...buffer.finish()]
    expect(chunks.join('')).toBe(source)
    expect(chunks.every(text => Array.from(text).length <= 120)).toBe(true)
    expect(chunks.every(text => !/[\uD800-\uDBFF]$/.test(text))).toBe(true)
    const leading = new SentenceBuffer(), long = '\n' + '字'.repeat(200)
    const parts = [...leading.append(long), ...leading.finish()]
    expect(parts.join('')).toBe(long)
    expect(parts.every(part => !!part.trim())).toBe(true)
  })

  it('plays beyond three minutes with one-second in-flight audio and real progress', async () => {
    vi.useFakeTimers()
    vi.mocked(synthesizeAudio).mockImplementation(async () => Buffer.alloc(24_000 * 2 * 61))
    let sent = 0, played = 0, peak = 0, final = 0
    const began = Date.now()
    const player = new ReplyPlayback('fixture', {} as never, {
      valid() {}, text() {}, cancel() {},
      audio(_sequence: number, pcm: Buffer) { sent += pcm.length / 2; peak = Math.max(peak, sent - played) },
      end(_text: string, count: number) { final = count },
    })
    player.append(0, '这是第一段。接下来是第二段。最后是第三段。'); player.end()
    for (let elapsed = 0; elapsed < 184_000 && (!final || played < final); elapsed += 250) {
      await vi.advanceTimersByTimeAsync(250)
      played = Math.min(sent, played + 6000)
      if (played > 0) player.progress(played)
    }
    expect(final).toBe(24_000 * 183)
    expect(Date.now() - began).toBeGreaterThanOrEqual(183_000)
    expect(peak).toBeLessThanOrEqual(24_000)
    player.receipt('completed', final)
    expect((await player.done).played_samples).toBe(final)
  })

  it('rejects invalid or stationary progress instead of treating it as playback', async () => {
    vi.useFakeTimers()
    const player = new ReplyPlayback('fixture', {} as never, {
      valid() {}, text() {}, audio() {}, end() {}, cancel() {},
    })
    const rejected = expect(player.done).rejects.toThrow()
    player.append(0, '请完整播放。'); player.end()
    await vi.advanceTimersByTimeAsync(100)
    player.progress(100_000)
    await rejected
  })

  it('backpressures before accepting text and releases a blocked writer immediately on cancel', async () => {
    vi.useFakeTimers()
    vi.mocked(synthesizeAudio).mockImplementation(async () => Buffer.alloc(48_000 * 10))
    let sent = 0
    const cancel = vi.fn(), player = new ReplyPlayback('fixture', {} as never, {
      valid() {}, text() {}, end() {}, cancel,
      audio(_sequence, pcm) { sent += pcm.length / 2 },
    })
    player.append(0, '第一句。')
    await vi.advanceTimersByTimeAsync(10)
    expect(sent).toBe(24000)
    expect(player.append(1, '甲'.repeat(120))).toBe(true)
    expect(player.append(2, '乙'.repeat(120))).toBe(true)
    expect(player.append(3, '丙'.repeat(120))).toBe(false)
    expect(player.fragments).toHaveLength(3)
    expect(player.append(2, '乙'.repeat(120))).toBe(true)
    expect(() => player.append(2, '冲突')).toThrow()
    player.cancel('用户打断')
    await expect(player.done).rejects.toThrow('用户打断')
    expect(cancel).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(10)
    expect(sent).toBe(24000)
  })

  it('stationary progress cannot renew the five-second consumption watchdog', async () => {
    vi.useFakeTimers()
    vi.mocked(synthesizeAudio).mockImplementation(async () => Buffer.alloc(48_000 * 10))
    const player = new ReplyPlayback('fixture', {} as never, { valid() {}, text() {}, audio() {}, end() {}, cancel() {} })
    const rejected = expect(player.done).rejects.toThrow('5 秒没有前进')
    player.append(0, '开始。'); player.end()
    await vi.advanceTimersByTimeAsync(10); player.progress(480)
    for (let i = 0; i < 6; i++) { player.progress(480); await vi.advanceTimersByTimeAsync(1000) }
    await rejected
  })
})
