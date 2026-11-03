import { expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mediaServer } from './fixtures/https-media.js'
import { SlackMedia } from '../src/media.js'
import { SlackClient } from '../src/slack-client.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh5sAAAAASUVORK5CYII=', 'base64')
it.each(['custom', 'system', 'none'] as const)('downloads real bytes, uploads and confirms shares over HTTPS in %s mode', async mode => {
  const requests: Array<{ url: string; auth?: string; body: Buffer }> = []
  let origin = '', shared = false, allowed = true
  const fixture = await mediaServer(mode, async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    requests.push({ url: req.url!, auth: req.headers.authorization, body })
    const send = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.url === '/api/conversations.info') return send({ ok: true, channel: { id: 'C1', is_member: allowed } })
    if (req.url === '/api/files.info') {
      const id = new URLSearchParams(body.toString()).get('file')!
      return send({ ok: true, file: { id, name: id + '.png', mimetype: id === 'FVIDEO' ? 'video/mp4' : 'image/png', size: png.length, url_private_download: origin + '/download',
        ...(shared && id === 'FUP' ? { shares: { public: { C1: [{ ts: '1234.000001' }] } } } : {}) } })
    }
    if (req.url === '/api/files.getUploadURLExternal') return send({ ok: true, file_id: 'FUP', upload_url: origin + '/upload' })
    if (req.url === '/api/files.completeUploadExternal') { shared = true; return send({ ok: true, files: [{ id: 'FUP' }] }) }
    if (req.url === '/download' || req.url === '/large') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); return }
    if (req.url === '/upload') { res.end('OK'); return }
    if (req.url === '/redirect') { res.writeHead(302, { location: 'https://evil.example.test/stolen' }); res.end(); return }
    res.writeHead(404); res.end()
  })
  origin = fixture.origin
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-media-tls-'))
  const client = new SlackClient('xoxb-fixture', 'xapp-fixture')
  ;(client as any).web.slackApiUrl = origin + '/api/'
  const events: any[] = []
  const options = { dir, token: 'xoxb-fixture', channelId: 'slack-test', api: client, session: () => ({ platform_session_id: 'C1' }), publish: async (event: any) => { events.push(event) } }
  const media = new SlackMedia(options)
  let restarted: SlackMedia | undefined
  try {
    await media.project('s', 'C1', '100.001', { files: [{ id: 'F1', name: 'image.png', mimetype: 'image/png' }] })
    const image = await media.fetchImage({ session_id: 's', platform_message_id: '100.001', attachment_id: 'F1', quality: 'hd' })
    expect(image.status).toBe('ready')
    if (image.status !== 'ready') throw new Error('image not ready')
    expect(await fs.readFile(image.file_path)).toEqual(png)
    expect((await media.fetchImage({ session_id: 's', platform_message_id: '100.001', quality: 'hd' })).status).toBe('ready')
    expect(requests.filter(r => r.url === '/download')).toHaveLength(1)
    const result = await media.share({ filePath: image.file_path, filename: 'result.png', size: png.length }, 'C1')
    expect(result.ts).toBe('1234.000001')
    expect(requests.find(r => r.url === '/download')?.auth).toBe('Bearer xoxb-fixture')
    expect(requests.find(r => r.url === '/upload')).toMatchObject({ body: png, auth: undefined })
    expect(requests.filter(r => r.url === '/api/files.completeUploadExternal')).toHaveLength(1)
    expect(new URLSearchParams(requests.find(r => r.url === '/api/files.completeUploadExternal')!.body.toString()).get('channel_id')).toBe('C1')
    const video = await media.project('s', 'C1', '100.002', { files: [{ id: 'FVIDEO', name: 'clip.mp4', mimetype: 'video/mp4', size: 10 * 1024 * 1024 }] })
    expect(await media.fetchMedia(video.handle!)).toEqual({ status: 'fetching' })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({ type: 'media.download_completed', source: 'slack-test', payload: { channel_id: 'slack-test', session_id: 's', handle: video.handle, status: 'ready' } })
    const fetched = await media.fetchMedia(video.handle!)
    expect(fetched.status).toBe('ready')
    if (fetched.status !== 'ready') throw new Error('file not ready')
    expect(await fs.readFile(fetched.file_path)).toEqual(png)
    restarted = new SlackMedia(options)
    expect(await restarted.fetchMedia(video.handle!)).toMatchObject({ status: 'ready', file_path: fetched.file_path })
    allowed = false
    expect(await restarted.fetchMedia(video.handle!)).toMatchObject({ status: 'failed' })
    expect(await media.fetchImage({ session_id: 's', platform_message_id: '100.001', quality: 'hd' })).toMatchObject({ status: 'failed' })
    allowed = true
    await fs.rm(fetched.file_path)
    expect(await restarted.fetchMedia(video.handle!)).toEqual({ status: 'fetching' })
    await vi.waitFor(() => expect(events).toHaveLength(2))
    await expect(media.transport.run(signal => media.transport.download(origin + '/redirect', 'x', true, 1000, signal))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    await expect(media.transport.run(signal => media.transport.download(origin + '/large', 'x', true, 10, signal))).rejects.toMatchObject({ code: 'CHANNEL_FILE_TOO_LARGE' })
    await media.transport.run(signal => media.transport.download(origin + '/download', 'public.png', false, 1000, signal))
    expect(requests.filter(r => r.url === '/download').at(-1)?.auth).toBeUndefined()
    expect((await fs.readdir(path.join(dir, 'media'))).some(name => name.endsWith('.part'))).toBe(false)
    if (mode === 'none') expect(fixture.connects).toEqual([])
    else expect(fixture.connects.length).toBeGreaterThan(0)
  } finally {
    media.stop(); restarted?.stop(); await client.stop(); await fixture.close(); await fs.rm(dir, { force: true, recursive: true })
  }
}, 15000)

it('cancels an active HTTPS body on stop and removes the incomplete file without a completion event', async () => {
  let origin = ''
  const fixture = await mediaServer('none', (req, res) => {
    if (req.url === '/slow') { res.writeHead(200); res.write('first chunk'); return }
    res.writeHead(404); res.end()
  })
  origin = fixture.origin
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-media-stop-'))
  const publish = vi.fn()
  const media = new SlackMedia({ dir, token: 'secret', channelId: 'slack-test', session: () => ({ platform_session_id: 'C1' }), publish,
    api: { call: vi.fn(async (method: string) => method === 'conversations.info' ? { channel: { id: 'C1', is_member: true } }
      : { file: { id: 'F1', name: 'large.zip', mimetype: 'application/zip', url_private_download: origin + '/slow' } }) } as any })
  try {
    const content = await media.project('s', 'C1', '100.001', { files: [{ id: 'F1', name: 'large.zip', mimetype: 'application/zip', size: 10 * 1024 * 1024 }] })
    expect(await media.fetchMedia(content.handle!)).toEqual({ status: 'fetching' })
    await vi.waitFor(async () => expect(await fs.readdir(path.join(dir, 'media'))).toHaveLength(1))
    media.stop()
    await vi.waitFor(async () => expect(await fs.readdir(path.join(dir, 'media'))).toEqual([]))
    expect(publish).not.toHaveBeenCalled()
    expect(await media.fetchMedia(content.handle!)).toMatchObject({ status: 'failed' })
  } finally { media.stop(); await fixture.close(); await fs.rm(dir, { recursive: true, force: true }) }
})
