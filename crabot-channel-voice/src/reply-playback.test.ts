import { describe, expect, it, vi } from 'vitest'
vi.mock('crabot-shared', () => ({ synthesizeAudio: vi.fn(async () => Buffer.alloc(1200)) }))
import { ReplyPlayback, SentenceBuffer } from './reply-playback.js'

describe('continuous sentence playback', () => {
  it('keeps decimals and incomplete sentences intact', () => {
    const buffer = new SentenceBuffer()
    expect(buffer.append('温度是3.')).toEqual([])
    expect(buffer.append('14度。下一句')).toEqual(['温度是3.14度。'])
    expect(buffer.finish()).toEqual(['下一句'])
  })
  it('sends first audio before text ends and stitches sentence tails into one verified playback', async () => {
    const frames: number[] = [], starts: string[] = [], endings: number[] = []
    const play = new ReplyPlayback('playback', { provider_id: 'fixture', format: 'mlx-audio-http', endpoint: 'http://fixture', model_id: 'fixture', voice: 'fixture' }, {
      valid: () => {}, start: text => { starts.push(text) }, audio: (seq, pcm) => { expect(seq).toBe(frames.length); frames.push(pcm.length / 2) },
      end: (_, count) => { endings.push(count) }, cancel: () => {},
    })
    play.append(0, '第一句。'); await vi.waitFor(() => expect(frames).toEqual([480]))
    expect(endings).toEqual([]); expect(starts).toEqual(['第一句。'])
    play.receipt('started', 480); play.append(1, '第二句。'); play.end()
    await vi.waitFor(() => expect(endings).toEqual([1200]))
    expect(frames).toEqual([480, 480, 240])
    let completed = false; void play.done.then(() => { completed = true })
    await Promise.resolve(); expect(completed).toBe(false)
    play.receipt('completed', 1200); expect((await play.done).played_samples).toBe(1200)
  })
})
