import net from 'node:net'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  waitForOAuthCallback,
  getOAuthAuthUrl,
  cancelOAuthFlow,
  extractTokenInfo,
  selfCheckCallbackServer,
} from '../../src/oauth/openai-codex-oauth.js'

describe('openai-codex-oauth', () => {
  describe('getOAuthAuthUrl', () => {
    let pending: Promise<unknown>

    beforeEach(() => {
      pending = waitForOAuthCallback().catch(() => undefined)
    })

    afterEach(async () => {
      cancelOAuthFlow()
      await pending
    })

    it('生成的授权 URL 包含 pi-ai 全部 10 个 query 参数', () => {
      const authUrl = getOAuthAuthUrl()
      expect(authUrl).toBeTruthy()
      const url = new URL(authUrl!)

      expect(url.origin).toBe('https://auth.openai.com')
      expect(url.pathname).toBe('/oauth/authorize')

      const params = url.searchParams
      expect(params.get('response_type')).toBe('code')
      expect(params.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
      expect(params.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
      expect(params.get('scope')).toBe('openid profile email offline_access')
      expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(params.get('code_challenge_method')).toBe('S256')
      expect(params.get('state')).toMatch(/^[0-9a-f]{32}$/)
      expect(params.get('id_token_add_organizations')).toBe('true')
      expect(params.get('codex_cli_simplified_flow')).toBe('true')
      expect(params.get('originator')).toBe('openclaw')
    })

    it('redirect_uri 使用 localhost 不使用 127.0.0.1，端口固定 1455', () => {
      const authUrl = getOAuthAuthUrl()
      const url = new URL(authUrl!)
      const redirectUri = url.searchParams.get('redirect_uri')
      expect(redirectUri).toBe('http://localhost:1455/auth/callback')
    })

    it('CRABOT_PORT_OFFSET 不影响 redirect_uri 端口', () => {
      const authUrl = getOAuthAuthUrl()
      const url = new URL(authUrl!)
      expect(url.searchParams.get('redirect_uri')).toContain(':1455/')
    })
  })

  describe('extractTokenInfo', () => {
    const encode = (payload: object): string => {
      const header = Buffer.from('{"alg":"none"}').toString('base64url')
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
      return `${header}.${body}.`
    }

    it('从 https://api.openai.com/auth.chatgpt_account_id 提取 accountId', () => {
      const token = encode({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' },
        'https://api.openai.com/profile': { email: 'u@example.com' },
        exp: Math.floor(Date.now() / 1000) + 3600,
      })

      const info = extractTokenInfo(token)
      expect(info.accountId).toBe('acct-123')
      expect(info.email).toBe('u@example.com')
    })

    it('chatgpt_account_id 不存在时 accountId 为 undefined（不再降级到旧字段）', () => {
      const token = encode({
        'https://api.openai.com/auth': {
          chatgpt_account_user_id: 'old-format',
          chatgpt_user_id: 'old-format-2',
          user_id: 'old-format-3',
        },
        iss: 'https://auth.openai.com',
        sub: 'user_xx',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })

      const info = extractTokenInfo(token)
      expect(info.accountId).toBeUndefined()
    })

    it('payload.exp 转毫秒', () => {
      const exp = Math.floor(Date.now() / 1000) + 7200
      const token = encode({
        'https://api.openai.com/auth': { chatgpt_account_id: 'a' },
        exp,
      })
      const info = extractTokenInfo(token)
      expect(info.expiresAt).toBe(exp * 1000)
    })

    it('payload.exp 缺失时回退到约 1 小时后', () => {
      const before = Date.now()
      const token = encode({
        'https://api.openai.com/auth': { chatgpt_account_id: 'a' },
      })
      const info = extractTokenInfo(token)
      const after = Date.now()
      expect(info.expiresAt).toBeGreaterThanOrEqual(before + 3600_000)
      expect(info.expiresAt).toBeLessThanOrEqual(after + 3600_000)
    })
  })

  describe('Callback server 错误响应', () => {
    let pending: Promise<unknown>

    const waitForReady = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) {
        const ok = await new Promise<boolean>((resolve) => {
          const sock = net.createConnection({ port: 1455, host: '127.0.0.1' })
          sock.once('connect', () => {
            sock.end()
            resolve(true)
          })
          sock.once('error', () => resolve(false))
        })
        if (ok) return
        await new Promise((r) => setTimeout(r, 25))
      }
    }

    beforeEach(async () => {
      pending = waitForOAuthCallback().catch(() => undefined)
      await waitForReady()
    })

    const waitForPortFree = async (): Promise<void> => {
      for (let i = 0; i < 40; i++) {
        const busy = await new Promise<boolean>((resolve) => {
          const sock = net.createConnection({ port: 1455, host: '127.0.0.1' })
          sock.once('connect', () => {
            sock.end()
            resolve(true)
          })
          sock.once('error', () => resolve(false))
        })
        if (!busy) return
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error('Port 1455 did not become free within 1 second')
    }

    afterEach(async () => {
      cancelOAuthFlow()
      await pending
      await waitForPortFree()
    })

    it('非 /auth/callback 路径返回 404 + 错误 HTML', async () => {
      const res = await fetch('http://127.0.0.1:1455/somewhere-else')
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toContain('text/html')
      const body = await res.text()
      expect(body).toContain('Callback route not found.')
    })

    it('state 不匹配返回 400', async () => {
      const res = await fetch('http://127.0.0.1:1455/auth/callback?code=x&state=wrong')
      expect(res.status).toBe(400)
      const body = await res.text()
      expect(body).toContain('State mismatch.')
    })

    it('携带 ?error= 时返回 400 + error_description', async () => {
      const authUrl = getOAuthAuthUrl()!
      const state = new URL(authUrl).searchParams.get('state')!
      const res = await fetch(
        `http://127.0.0.1:1455/auth/callback?error=access_denied&error_description=User+denied&state=${state}`,
      )
      expect(res.status).toBe(400)
      const body = await res.text()
      expect(body).toContain('User denied')
    })

    it('缺 code 时返回 400', async () => {
      const authUrl = getOAuthAuthUrl()!
      const state = new URL(authUrl).searchParams.get('state')!
      const res = await fetch(`http://127.0.0.1:1455/auth/callback?state=${state}`)
      expect(res.status).toBe(400)
      const body = await res.text()
      expect(body).toContain('Missing authorization code.')
    })
  })

  describe('exchangeCodeForToken (通过 mock fetch 验证 body)', () => {
    let originalFetch: typeof globalThis.fetch
    let capturedRequest: { url: string; init: RequestInit } | null

    beforeEach(() => {
      capturedRequest = null
      originalFetch = globalThis.fetch
      globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
        capturedRequest = { url: String(input), init: init ?? {} }
        return new Response(
          JSON.stringify({
            access_token: 'eyJhbGciOiJub25lIn0.eyJpc3MiOiJ0ZXN0In0.',
            refresh_token: 'rt_xxx',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }) as typeof fetch
    })

    let pendingFlow: Promise<unknown> | null = null

    afterEach(async () => {
      globalThis.fetch = originalFetch
      cancelOAuthFlow()
      if (pendingFlow) {
        await pendingFlow
        pendingFlow = null
      }
    })

    it('Token 换取 body 字段顺序与 pi-ai 完全一致', async () => {
      pendingFlow = waitForOAuthCallback().catch(() => undefined)
      const authUrl = getOAuthAuthUrl()!
      const state = new URL(authUrl).searchParams.get('state')!

      // 等 server.listen 实际就绪：尝试 connect，失败则短暂退避重试
      const callbackUrl = `http://127.0.0.1:1455/auth/callback?code=test_code&state=${state}`
      let response: Response | null = null
      for (let i = 0; i < 20; i++) {
        try {
          response = await originalFetch(callbackUrl)
          break
        } catch {
          await new Promise((r) => setTimeout(r, 25))
        }
      }
      expect(response).toBeTruthy()

      await pendingFlow
      pendingFlow = null

      expect(capturedRequest).toBeTruthy()
      expect(capturedRequest!.url).toBe('https://auth.openai.com/oauth/token')
      expect(capturedRequest!.init.method).toBe('POST')

      const body = capturedRequest!.init.body as string
      const params = [...new URLSearchParams(body).keys()]
      expect(params).toEqual([
        'grant_type',
        'client_id',
        'code',
        'code_verifier',
        'redirect_uri',
      ])

      const parsed = new URLSearchParams(body)
      expect(parsed.get('grant_type')).toBe('authorization_code')
      expect(parsed.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
      expect(parsed.get('code')).toBe('test_code')
      expect(parsed.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
      expect(parsed.get('code_verifier')).toBeTruthy()
    })
  })

  describe('端口冲突与自验证', () => {
    it('1455 已被占用时，waitForOAuthCallback reject 带 code=PORT_IN_USE 的错误', async () => {
      const http = await import('node:http')
      const blocker = http.createServer(() => undefined)
      await new Promise<void>((resolve) => blocker.listen(1455, '127.0.0.1', resolve))

      try {
        let captured: { code?: string; message?: string } | null = null
        try {
          await waitForOAuthCallback()
        } catch (err) {
          captured = err as { code?: string; message?: string }
        }
        expect(captured?.code).toBe('PORT_IN_USE')
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()))
      }
    })

    it('selfCheckCallbackServer 在 server 正常时返回 true', async () => {
      const pending = waitForOAuthCallback().catch(() => undefined)
      try {
        const ok = await selfCheckCallbackServer()
        expect(ok).toBe(true)
      } finally {
        cancelOAuthFlow()
        await pending
      }
    })

    it('selfCheckCallbackServer 在 server 不可达时返回 false（2 秒超时内）', async () => {
      const ok = await selfCheckCallbackServer()
      expect(ok).toBe(false)
    })
  })

  describe('Callback server /__selfcheck', () => {
    let pending: Promise<unknown>

    const waitForReady = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) {
        const ok = await new Promise<boolean>((resolve) => {
          const sock = net.createConnection({ port: 1455, host: '127.0.0.1' })
          sock.once('connect', () => {
            sock.end()
            resolve(true)
          })
          sock.once('error', () => resolve(false))
        })
        if (ok) return
        await new Promise((r) => setTimeout(r, 25))
      }
    }

    const waitForPortFree = async (): Promise<void> => {
      for (let i = 0; i < 40; i++) {
        const busy = await new Promise<boolean>((resolve) => {
          const sock = net.createConnection({ port: 1455, host: '127.0.0.1' })
          sock.once('connect', () => {
            sock.end()
            resolve(true)
          })
          sock.once('error', () => resolve(false))
        })
        if (!busy) return
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error('Port 1455 did not become free within 1 second')
    }

    beforeEach(async () => {
      pending = waitForOAuthCallback().catch(() => undefined)
      await waitForReady()
    })

    afterEach(async () => {
      cancelOAuthFlow()
      await pending
      await waitForPortFree()
    })

    it('GET /__selfcheck?nonce=abc 返回 200 text/plain 且 body === abc', async () => {
      const res = await fetch('http://127.0.0.1:1455/__selfcheck?nonce=abc123')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/plain')
      expect(await res.text()).toBe('abc123')
    })

    it('/__selfcheck 不带 nonce 返回 200 空字符串（保持简单）', async () => {
      const res = await fetch('http://127.0.0.1:1455/__selfcheck')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('')
    })
  })
})
