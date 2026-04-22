/**
 * OpenAI Codex OAuth 配置和工具函数
 *
 * 实现 OAuth 2.0 Authorization Code + PKCE 流程
 * 使用 Codex CLI 的公开 client_id（OpenAI 默许第三方工具使用）
 */

import crypto from 'crypto'
import http from 'http'
import net from 'net'
import { oauthErrorHtml, oauthSuccessHtml } from './oauth-page.js'

// --- OAuth 配置 ---

const CALLBACK_PORT = 1455
const ORIGINATOR = 'openclaw'
const DEFAULT_REDIRECT_HOST = 'localhost'

const OAUTH_CONFIG = {
  authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  callbackPort: CALLBACK_PORT,
  scope: 'openid profile email offline_access',
  originator: ORIGINATOR,
}

function buildRedirectUri(host: string): string {
  return `http://${host}:${CALLBACK_PORT}/auth/callback`
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/**
 * 解析 callback server 应绑定的地址。
 * Loopback 主机只绑定到本机；IP 字面量绑定到该具体 IP（避免把端口暴露到其他网卡）；
 * DNS 名称无法在同步上下文解析，退回到 0.0.0.0。
 */
function resolveBindAddress(host: string): string {
  if (isLoopbackHost(host)) return '127.0.0.1'
  if (net.isIP(host)) return host
  return '0.0.0.0'
}

/**
 * 从可选的显式值和 HTTP Host 头中解析回调使用的主机名。
 * 用于 Admin 模块决定 OAuth redirect_uri 的域名——让 OpenAI 回调到浏览器实际访问的地址。
 */
export function resolveRedirectHost(
  explicit: string | undefined,
  hostHeader: string | undefined,
): string {
  const trimmed = explicit?.trim()
  if (trimmed) return trimmed
  if (hostHeader) {
    try {
      return new URL(`http://${hostHeader}`).hostname || DEFAULT_REDIRECT_HOST
    } catch {
      // Host 头异常时退回默认
    }
  }
  return DEFAULT_REDIRECT_HOST
}

// --- PKCE ---

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

function generateState(): string {
  return crypto.randomBytes(16).toString('hex')
}

// --- JWT 解析 ---

export interface CodexJwtPayload {
  exp?: number
  'https://api.openai.com/profile'?: { email?: string }
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string
  }
}

function decodeJwtPayload(token: string): CodexJwtPayload | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8')
    return JSON.parse(payload) as CodexJwtPayload
  } catch {
    return null
  }
}

export function extractTokenInfo(accessToken: string): {
  email?: string
  accountId?: string
  expiresAt: number
} {
  const payload = decodeJwtPayload(accessToken)
  if (!payload) {
    return { expiresAt: Date.now() + 3600_000 }
  }

  const profile = payload['https://api.openai.com/profile']
  const auth = payload['https://api.openai.com/auth']

  return {
    email: profile?.email,
    accountId: auth?.chatgpt_account_id,
    expiresAt: payload.exp ? payload.exp * 1000 : Date.now() + 3600_000,
  }
}

// --- OAuth 流程 ---

export interface OAuthLoginResult {
  access_token: string
  refresh_token: string
  expires_at: number
  account_id?: string
  email?: string
}

interface PendingOAuthFlow {
  state: string
  codeVerifier: string
  redirectUri: string
  resolve: (result: OAuthLoginResult) => void
  reject: (error: Error) => void
  server: http.Server
  timeout: ReturnType<typeof setTimeout>
}

let pendingFlow: PendingOAuthFlow | null = null

export interface WaitForOAuthCallbackOptions {
  /** 回调 URL 使用的主机名。默认 'localhost'；从局域网/远程访问时应传入访问 UI 的域名。 */
  redirectHost?: string
}

/**
 * 启动回调服务器，等待 OAuth 回调
 * 返回 Promise，登录成功时 resolve
 */
export function waitForOAuthCallback(
  options: WaitForOAuthCallbackOptions = {},
): Promise<OAuthLoginResult> {
  return new Promise((resolve, reject) => {
    const redirectHost = options.redirectHost?.trim() || DEFAULT_REDIRECT_HOST
    const redirectUri = buildRedirectUri(redirectHost)
    const bindAddress = resolveBindAddress(redirectHost)

    const state = generateState()
    const codeVerifier = generateCodeVerifier()

    // 清理之前的 pending flow
    if (pendingFlow) {
      pendingFlow.server.close()
      clearTimeout(pendingFlow.timeout)
      pendingFlow.reject(new Error('Superseded by new login attempt'))
    }

    const sendHtml = (res: http.ServerResponse, statusCode: number, body: string): void => {
      res.writeHead(statusCode, {
        'Content-Type': 'text/html; charset=utf-8',
        'Connection': 'close',
      })
      res.end(body)
    }

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${OAUTH_CONFIG.callbackPort}`)

        if (url.pathname === '/__selfcheck') {
          const nonce = url.searchParams.get('nonce') ?? ''
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Connection': 'close' })
          res.end(nonce)
          return
        }

        if (url.pathname !== '/auth/callback') {
          sendHtml(res, 404, oauthErrorHtml('Callback route not found.'))
          return
        }

        const oauthError = url.searchParams.get('error')
        if (oauthError) {
          const errorDesc = url.searchParams.get('error_description') ?? oauthError
          sendHtml(res, 400, oauthErrorHtml(errorDesc))
          cleanup()
          reject(new Error(`OAuth error: ${oauthError}`))
          return
        }

        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')

        if (returnedState !== state) {
          sendHtml(res, 400, oauthErrorHtml('State mismatch.'))
          return
        }

        if (!code) {
          sendHtml(res, 400, oauthErrorHtml('Missing authorization code.'))
          return
        }

        try {
          const tokenResult = await exchangeCodeForToken(code, codeVerifier, redirectUri)
          sendHtml(res, 200, oauthSuccessHtml('OpenAI authentication completed. You can close this window.'))
          cleanup()
          resolve(tokenResult)
        } catch (err) {
          sendHtml(res, 500, oauthErrorHtml(err instanceof Error ? err.message : String(err)))
          cleanup()
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      } catch {
        sendHtml(res, 500, oauthErrorHtml('Internal error while processing OAuth callback.'))
      }
    })

    const cleanup = () => {
      if (pendingFlow) {
        clearTimeout(pendingFlow.timeout)
        pendingFlow = null
      }
      server.close()
    }

    // 5 分钟超时
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('OAuth login timed out (5 minutes)'))
    }, 5 * 60 * 1000)

    server.listen(OAUTH_CONFIG.callbackPort, bindAddress, () => {
      // Server ready
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      cleanup()
      if (err.code === 'EADDRINUSE') {
        const e = new Error(`Port ${OAUTH_CONFIG.callbackPort} is already in use`) as Error & { code: string }
        e.code = 'PORT_IN_USE'
        reject(e)
      } else {
        reject(new Error(`Failed to start callback server: ${err.message}`))
      }
    })

    pendingFlow = {
      state,
      codeVerifier,
      redirectUri,
      resolve,
      reject,
      server,
      timeout,
    }

    // authUrl is accessible via getOAuthAuthUrl()
  })
}

/**
 * 获取当前 pending flow 的授权 URL（供 API 返回给前端）
 */
export function getOAuthAuthUrl(): string | null {
  if (!pendingFlow) return null

  const codeChallenge = generateCodeChallenge(pendingFlow.codeVerifier)
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CONFIG.clientId,
    redirect_uri: pendingFlow.redirectUri,
    scope: OAUTH_CONFIG.scope,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: pendingFlow.state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: OAUTH_CONFIG.originator,
  })

  return `${OAUTH_CONFIG.authorizationEndpoint}?${params.toString()}`
}

// --- Token 换取 ---

async function exchangeCodeForToken(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<OAuthLoginResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: OAUTH_CONFIG.clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  })

  const response = await fetch(OAUTH_CONFIG.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Token exchange failed (${response.status}): ${errorText}`)
  }

  const data = await response.json() as {
    access_token: string
    refresh_token?: string
    expires_in?: number
    token_type?: string
  }

  const tokenInfo = extractTokenInfo(data.access_token)

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? '',
    expires_at: tokenInfo.expiresAt,
    account_id: tokenInfo.accountId,
    email: tokenInfo.email,
  }
}

// --- Token 刷新 ---

export async function refreshOAuthToken(refreshToken: string): Promise<OAuthLoginResult> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CONFIG.clientId,
  })

  const response = await fetch(OAUTH_CONFIG.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Token refresh failed (${response.status}): ${errorText}`)
  }

  const data = await response.json() as {
    access_token: string
    refresh_token?: string
    expires_in?: number
  }

  const tokenInfo = extractTokenInfo(data.access_token)

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? refreshToken,
    expires_at: tokenInfo.expiresAt,
    account_id: tokenInfo.accountId,
    email: tokenInfo.email,
  }
}

/**
 * 检查 OAuth 登录是否正在进行中
 */
export function isOAuthPending(): boolean {
  return pendingFlow !== null
}

/**
 * 使用 node:http 原生请求（绕过 undici globalDispatcher 代理）验证回调 server 是否属于本实例。
 * 向 127.0.0.1:1455/__selfcheck?nonce=<随机值> 发送 GET，校验响应体是否原样返回该 nonce。
 */
export function selfCheckCallbackServer(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const nonce = crypto.randomBytes(16).toString('hex')
    const req = http.request(
      {
        host: '127.0.0.1',
        port: OAUTH_CONFIG.callbackPort,
        path: `/__selfcheck?nonce=${nonce}`,
        method: 'GET',
        timeout: 2000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8')
          done(res.statusCode === 200 && body === nonce)
        })
      },
    )
    req.on('error', () => done(false))
    req.on('timeout', () => {
      req.destroy()
      done(false)
    })
    req.end()
  })
}

/**
 * 取消当前 pending 的 OAuth 流程
 */
export function cancelOAuthFlow(): void {
  if (pendingFlow) {
    pendingFlow.server.close()
    clearTimeout(pendingFlow.timeout)
    pendingFlow.reject(new Error('OAuth flow cancelled'))
    pendingFlow = null
  }
}
