import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createImageReader } from '../../src/mcp/fetch-image.js'
import type { CrabMessagingDeps } from '../../src/mcp/crab-messaging.js'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let dir: string
let file: string
let call: ReturnType<typeof vi.fn>
let reader: ReturnType<typeof createImageReader>
const args = { channel_id: 'wechat-test', session_id: 's', platform_message_id: 'image-a' }
const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const parsed = (result: Awaited<ReturnType<typeof reader>>) => JSON.parse(result.content[0].text)
const waiting = { status: 'not_ready', image_quality: 'thumbnail' }
const ready = () => ({ status: 'ready', image_quality: 'hd', file_path: file, mime_type: 'image/png', size: bytes.length })
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fetch-image-'))
  file = path.join(dir, 'image.png')
  await fs.writeFile(file, bytes)
  vi.useFakeTimers()
  call = vi.fn().mockImplementation(async (_port, method) => method === 'get_capabilities' ? { supports_image_fetch: true } : waiting)
  reader = createImageReader({ rpcClient: { call }, moduleId: 'agent', resolveChannelPort: async () => 123 } as unknown as CrabMessagingDeps)
})
afterEach(async () => { vi.useRealTimers(); await fs.rm(dir, { recursive: true, force: true }) })

describe('调用级图片等待', () => {
  it('等待后返回高清内容，无轮询模型或会话广播', async () => {
    const work = reader(args)
    await vi.advanceTimersByTimeAsync(1_000)
    call.mockImplementation(async (_port, method) => method === 'get_capabilities' ? { supports_image_fetch: true } : ready())
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await work
    expect(parsed(result)).toMatchObject({ status: 'ready', image_quality: 'hd' })
    expect(result.images).toEqual([{ media_type: 'image/png', data: bytes.toString('base64') }])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('重复请求合并，不延长 120 秒期限', async () => {
    const controller = new AbortController()
    const first = reader(args, { abortSignal: controller.signal })
    await vi.advanceTimersByTimeAsync(60_000)
    const second = reader({ ...args, include_image: false }, { abortSignal: controller.signal })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(parsed(await first)).toMatchObject({ status: 'timed_out', note: expect.stringContaining('暂未取得') })
    expect(parsed(await second).status).toBe('timed_out')
    expect(call.mock.calls.filter(([, method]) => method === 'get_capabilities')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('取消后停止查询，迟到结果不触发其他处理', async () => {
    const controller = new AbortController()
    const work = reader(args, { abortSignal: controller.signal })
    await vi.advanceTimersByTimeAsync(1_000)
    controller.abort()
    expect(parsed(await work).status).toBe('cancelled')
    const count = call.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(call).toHaveBeenCalledTimes(count)
  })
  it('新输入中止等待，下一回合可以处理取消或变更', async () => {
    let pending = false
    const work = reader(args, { hasPendingExternalInput: () => pending })
    await vi.advanceTimersByTimeAsync(1_000)
    pending = true
    await vi.advanceTimersByTimeAsync(100)
    expect(parsed(await work).status).toBe('interrupted')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('不同图片不会因另一张就绪而结束等待', async () => {
    call.mockImplementation(async (_port, method, p) => method === 'get_capabilities' ? { supports_image_fetch: true }
      : p.platform_message_id === 'image-a' ? ready() : waiting)
    const a = reader({ ...args, include_image: false })
    const b = reader({ ...args, platform_message_id: 'image-b' })
    expect(parsed(await a).status).toBe('ready')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(parsed(await b).status).toBe('timed_out')
  })
  it('仅交付文件路径时不读取或注入图片', async () => {
    await fs.unlink(file)
    call.mockImplementation(async (_port, method) => method === 'get_capabilities' ? { supports_image_fetch: true } : ready())
    const result = await reader({ ...args, include_image: false })
    expect(parsed(result).status).toBe('ready')
    expect(result.images).toBeUndefined()
  })
  it('网络失败不伪装成高清未就绪，结束等待', async () => {
    call.mockRejectedValue(new Error('unavailable'))
    expect(parsed(await reader(args))).toEqual({ status: 'failed', error: 'unavailable' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('RPC 卡住也必须在期限内结束', async () => {
    call.mockImplementation(() => new Promise(() => {}))
    const work = reader(args)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(parsed(await work).status).toBe('timed_out')
    expect(vi.getTimerCount()).toBe(0)
  })
})
