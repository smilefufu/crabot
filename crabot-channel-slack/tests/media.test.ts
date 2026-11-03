import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SlackMedia } from '../src/media.js'
import { RpcError } from 'crabot-shared'
import { MediaTransport } from '../src/media-transport.js'
import { MAX_FILE_BYTES } from '../src/media-transport.js'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { force: true, recursive: true })))
it('includes metadata time in the same 120 second deadline as a nested transfer', async () => {
  vi.useFakeTimers()
  const transport = new MediaTransport('secret', 'unused')
  let nested: Promise<unknown> | undefined
  try {
    await transport.run(async () => {
      await vi.advanceTimersByTimeAsync(90_000)
      nested = transport.run(async () => new Promise(() => {}))
      // Background work keeps the original deadline after its caller returns fetching.
      void nested.catch(() => {})
    })
    const rejected = expect(nested).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
  } finally { transport.stop(); vi.useRealTimers() }
})
it('keeps multi-image and mixed-file references scoped to the original message across restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-media-')); dirs.push(dir)
  const api: any = { call: vi.fn(async () => ({})) }
  const options = { dir, token: 'secret', api, channelId: 'slack-test', session: (id: string) => ({ platform_session_id: id === 's1' ? 'C1' : 'C2' }), publish: vi.fn() }
  const media = new SlackMedia(options)
  const files = [{ id: 'F1', name: 'one.png', mimetype: 'image/png', size: 8 }, { id: 'F2', name: 'two.jpg', mimetype: 'image/jpeg' }, { id: 'F3', name: 'report.pdf', mimetype: 'application/pdf' }]
  const content = await media.project('s1', 'C1', '100.001', { text: 'bug', files })
  expect(content).toMatchObject({ type: 'image', image_quality: 'unknown' })
  expect(content.text).toContain('attachment_id=F1')
  expect(content.text).toContain('attachment_id=F2')
  expect(content.text).toContain('handle=fm_')
  const repeat = await new SlackMedia(options).project('s1', 'C1', '100.001', { text: 'bug', files })
  expect(repeat).toEqual(content)
  const recreated = await media.project('replacement-session', 'C1', '100.001', { files })
  expect(recreated.text?.match(/handle=fm_\w+/g)).not.toEqual(content.text?.match(/handle=fm_\w+/g))
  const bad = await media.fetchImage({ session_id: 's2', platform_message_id: '100.001', attachment_id: 'F1', quality: 'hd' })
  expect(bad.status).toBe('failed')
  expect(api.call).not.toHaveBeenCalled()
})
it('advertises every file type without eagerly downloading or exposing private URLs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-media-')); dirs.push(dir)
  const api: any = { call: vi.fn() }
  const media = new SlackMedia({ dir, token: 'secret', api, channelId: 'slack-test', session: () => ({ platform_session_id: 'D1' }), publish: vi.fn() })
  const content = await media.project('s', 'D1', '100.001', { files: ['audio/ogg', 'video/mp4', 'application/zip', 'application/octet-stream'].map((mimetype, i) => ({ id: 'F' + i, name: String(i), mimetype, url_private: 'https://files.slack.com/secret' })) })
  expect(content).toMatchObject({ type: 'file', status: 'not_fetched', handle: expect.stringMatching(/^fm_/) })
  expect(content.text?.match(/handle=fm_/g)).toHaveLength(4)
  expect(JSON.stringify(content)).not.toContain('https://')
  expect(api.call).not.toHaveBeenCalled()
})
it('accepts an exact 100 MiB source and rejects one byte more before uploading', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-media-')); dirs.push(dir)
  const filename = path.join(dir, 'boundary.bin'), fd = fs.openSync(filename, 'w')
  const call = vi.fn()
  const media = new SlackMedia({ dir, token: 'secret', channelId: 'slack-test', api: { call } as any, session: () => ({ platform_session_id: 'C1' }), publish: vi.fn() })
  try {
    fs.ftruncateSync(fd, MAX_FILE_BYTES)
    expect(await media.sources({ type: 'file', file_path: filename })).toMatchObject([{ size: MAX_FILE_BYTES }])
    fs.ftruncateSync(fd, MAX_FILE_BYTES + 1)
    await expect(media.sources({ type: 'file', file_path: filename })).rejects.toMatchObject({ code: 'CHANNEL_FILE_TOO_LARGE' })
    expect(call).not.toHaveBeenCalled()
  } finally { fs.closeSync(fd); media.stop() }
})

it('does not repeat finalization or count uploaded bytes as delivery when the share response is lost', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-media-')); dirs.push(dir)
  const call = vi.fn(async (method: string) => {
    if (method === 'files.getUploadURLExternal') return { file_id: 'FUP', upload_url: 'https://files.slack.com/upload' }
    throw new RpcError('SERVICE_UNAVAILABLE', '分享结果未知')
  })
  const media = new SlackMedia({ dir, channelId: 'slack-test', token: 'secret', api: { call } as any, session: () => ({ platform_session_id: 'C1' }), publish: vi.fn() })
  vi.spyOn(media.transport, 'upload').mockResolvedValue()
  await expect(media.share({ filePath: 'not-read-by-fixture', filename: 'a.bin', size: 1 }, 'C1')).rejects.toMatchObject({ details: { uploaded_file_ids: ['FUP'], delivery_unknown: true } })
  expect(call.mock.calls.map(([method]) => method)).toEqual(['files.getUploadURLExternal', 'files.completeUploadExternal'])
  media.stop()
})

it('never accepts a share timestamp from another channel and stops polling at the original deadline', async () => {
  vi.useFakeTimers()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-media-')); dirs.push(dir)
  const call = vi.fn(async (method: string) => {
    if (method === 'files.getUploadURLExternal') return { file_id: 'FUP', upload_url: 'https://files.slack.com/upload' }
    if (method === 'files.completeUploadExternal') return { ok: true }
    return { file: { id: 'FUP', shares: { public: { C2: [{ ts: '123.000001' }] } } } }
  })
  const media = new SlackMedia({ dir, channelId: 'slack-test', token: 'secret', api: { call } as any, session: () => ({ platform_session_id: 'C1' }), publish: vi.fn() })
  vi.spyOn(media.transport, 'upload').mockResolvedValue()
  try {
    const result = expect(media.share({ filePath: 'not-read', filename: 'a', size: 1 }, 'C1')).rejects.toMatchObject({ details: { uploaded_file_ids: ['FUP'], delivery_unknown: true } })
    await vi.advanceTimersByTimeAsync(120_000)
    await result
    expect(call.mock.calls.filter(([method]) => method === 'files.completeUploadExternal')).toHaveLength(1)
    const count = call.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(call).toHaveBeenCalledTimes(count)
  } finally { media.stop(); vi.useRealTimers() }
})
