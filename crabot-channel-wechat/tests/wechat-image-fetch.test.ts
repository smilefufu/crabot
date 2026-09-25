import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WechatImageFetcher } from '../src/image-fetch.js'
import { formatWechatContent } from '../src/format-wechat-content.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
let dir: string
let getMessage: ReturnType<typeof vi.fn>
let fetcher: WechatImageFetcher
const params = { session_id: 's', platform_message_id: 'm', quality: 'hd' as const }
const message = (origin: number | undefined, url = 'https://cdn/image') => ({
  id: 'm', fieldTalker: 'group', fieldType: 1, content: { type: 1, image_origin: origin, resource_url: url },
})
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-image-'))
  getMessage = vi.fn().mockResolvedValue(message(0))
  fetcher = new WechatImageFetcher({ dataDir: dir, getMessage, getTalker: s => s === 's' ? 'group' : undefined })
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(png)))
})
afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(dir, { recursive: true, force: true }) })

describe('微信按需图片', () => {
  it.each([[0, 'thumbnail'], [1, 'hd'], [undefined, 'unknown']])('如实保留质量 %s', (origin, quality) => {
    expect(formatWechatContent(1, message(origin as number).content).content.image_quality).toBe(quality)
  })
  it('缩略图只返回未就绪；高清补报后才下载，原始 bytes 与格式保留', async () => {
    expect(await fetcher.fetch(params)).toEqual({ status: 'not_ready', image_quality: 'thumbnail' })
    expect(fetch).not.toHaveBeenCalled()
    getMessage.mockResolvedValue(message(1))
    const ready = await fetcher.fetch(params)
    expect(ready).toMatchObject({ status: 'ready', image_quality: 'hd', mime_type: 'image/png', size: png.length })
    expect(await fs.readFile((ready as any).file_path)).toEqual(png)
    expect(await fetcher.fetch(params)).toEqual(ready)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(getMessage).toHaveBeenCalledTimes(3)
  })
  it('升级沿用同一 URL 也不能复用之前的缩略图缓存', async () => {
    const thumb = await fetcher.fetch({ ...params, quality: 'thumbnail' })
    getMessage.mockResolvedValue(message(1))
    const hd = await fetcher.fetch(params)
    expect((thumb as any).file_path).not.toBe((hd as any).file_path)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('缺少质量标记不能冒充高清', async () => {
    getMessage.mockResolvedValue(message(undefined))
    expect(await fetcher.fetch(params)).toEqual({ status: 'not_ready', image_quality: 'unknown' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('严格校验会话，不下载其他会话图片', async () => {
    getMessage.mockResolvedValue({ ...message(1), fieldTalker: 'other' })
    expect(await fetcher.fetch(params)).toMatchObject({ status: 'failed', error: expect.stringContaining('不属于') })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([null, { fieldTalker: 'group', fieldType: 0, content: {} }])('查询不可用或非图片明确失败', async msg => {
    getMessage.mockResolvedValue(msg)
    expect(await fetcher.fetch(params)).toMatchObject({ status: 'failed' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([new Response('error', { status: 403 }), new Response('not an image'), new Response('large', { headers: { 'content-length': String(21 * 1024 * 1024) } })])('下载失败、非图片或过大不冒充成功', async response => {
    getMessage.mockResolvedValue(message(1))
    vi.mocked(fetch).mockResolvedValue(response)
    expect(await fetcher.fetch(params)).toMatchObject({ status: 'failed' })
    expect(await fs.readdir(dir)).toEqual([])
  })
  it('没有 content-length 时也限制流式读取大小', async () => {
    getMessage.mockResolvedValue(message(1))
    vi.mocked(fetch).mockResolvedValue(new Response(new Uint8Array(20 * 1024 * 1024 + 1)))
    expect(await fetcher.fetch(params)).toMatchObject({ status: 'failed', error: expect.stringContaining('20MB') })
  })
  it('缓存被 GC 后重新下载，重复并发请求合并', async () => {
    getMessage.mockResolvedValue(message(1))
    const [a, b] = await Promise.all([fetcher.fetch(params), fetcher.fetch(params)])
    expect(a).toEqual(b)
    expect(fetch).toHaveBeenCalledTimes(1)
    await fs.unlink((a as any).file_path)
    expect(await fetcher.fetch(params)).toMatchObject({ status: 'ready' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})


it('channel 注册的取图 RPC 查询最新记录，保留原消息且不发布完成通知', async () => {
  const { WechatChannel } = await import('../src/wechat-channel.js')
  const register = vi.spyOn(WechatChannel.prototype as any, 'registerMethod')
  try {
    const channel = new WechatChannel({
      module_id: 'wechat-images', module_type: 'channel', version: '0.0.1', protocol_version: '0.1.0',
      port: 0, data_dir: dir, wechat: { connector_url: 'http://localhost:0', api_key: 'test', mode: 'socketio' },
    })
    vi.spyOn((channel as any).sessionManager, 'findById').mockReturnValue({ platform_session_id: 'group' })
    vi.spyOn((channel as any).client, 'getMessageById').mockImplementation(getMessage)
    const publish = vi.spyOn((channel as any).rpcClient, 'publishEvent')
    const rpc = register.mock.calls.find(([name]) => name === 'fetch_image')![1] as Function
    expect((channel as any).handleGetCapabilities().supports_image_fetch).toBe(true)
    expect(await rpc(params)).toEqual({ status: 'not_ready', image_quality: 'thumbnail' })
    getMessage.mockResolvedValue(message(1))
    expect(await rpc(params)).toMatchObject({ status: 'ready', image_quality: 'hd' })
    expect(getMessage.mock.calls).toEqual([['m'], ['m']])
    expect(publish).not.toHaveBeenCalled()
  } finally { vi.restoreAllMocks() }
})
