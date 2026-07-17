import { describe, it, expect, vi } from 'vitest'

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Domain: { Feishu: 'feishu', Lark: 'lark' },
  Client: class {
    request = vi.fn(async (opts: { url: string }) => {
      if (opts.url.includes('/ok')) return { code: 0, data: { hello: 'world' } }
      // wiki denied: SDK/Axios 收到 HTTP 400，throw 带 response.data 的 Error
      if (opts.url.includes('/wiki/denied')) {
        const err: any = new Error('no user authority')
        err.response = { status: 400, data: { code: 41050, msg: 'no user authority' } }
        throw err
      }
      // 无 payload 的网络异常（socket reset, DNS 失败等）
      if (opts.url.includes('/network-error')) {
        throw new Error('socket reset')
      }
      return { code: 99991663, msg: 'permission denied' }
    })
  },
}))

import { FeishuClient } from '../src/feishu-client.js'

function makeClient(): FeishuClient {
  return new FeishuClient({ app_id: 'cli_x', app_secret: 's', domain: 'feishu' })
}

describe('FeishuClient.rawGet', () => {
  it('成功时返回 data 字段', async () => {
    const data = await makeClient().rawGet<{ hello: string }>('/open-apis/ok')
    expect(data).toEqual({ hello: 'world' })
  })

  it('拼接 query 参数', async () => {
    const client = makeClient()
    const spy = (client as any).client.request as ReturnType<typeof vi.fn>
    await client.rawGet('/open-apis/ok', { lang: 0, foo: 'bar' })
    expect(spy.mock.calls[0][0].url).toContain('lang=0')
    expect(spy.mock.calls[0][0].url).toContain('foo=bar')
  })

  it('code 非 0 时抛 FeishuClientError，权限码映射 PERMISSION_DENIED', async () => {
    await expect(makeClient().rawGet('/open-apis/denied'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('wiki denied 41050 应抛 FeishuClientError 含 PERMISSION_DENIED + feishu_code/message + cause', async () => {
    await expect(makeClient().rawGet('/open-apis/wiki/denied'))
      .rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
        feishu_code: 41050,
        feishu_message: 'no user authority',
        cause: { message: 'no user authority' },
      })
  })

  it('socket reset 等无 payload 网络异常保持原对象身份', async () => {
    const socketError = new Error('socket reset')
    const client = makeClient()
    const requestMock = (client as any).client.request as ReturnType<typeof vi.fn>
    requestMock.mockImplementationOnce(async () => { throw socketError })
    await expect(client.rawGet('/open-apis/network-error'))
      .rejects.toBe(socketError)
  })
})
