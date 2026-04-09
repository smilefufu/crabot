/**
 * OpenAI Codex OAuth 配置和工具函数
 *
 * 实现 OAuth 2.0 Authorization Code + PKCE 流程
 * 使用 Codex CLI 的公开 client_id（OpenAI 默许第三方工具使用）
 */

import crypto from 'crypto'
import http from 'http'

// --- OAuth 配置 ---

const OAUTH_CALLBACK_BASE_PORT = 1455
const portOffset = parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)
const callbackPort = OAUTH_CALLBACK_BASE_PORT + portOffset

const OAUTH_CONFIG = {
  authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  redirectUri: `http://127.0.0.1:${callbackPort}/auth/callback`,
  callbackPort,
  scope: 'openid profile email offline_access',
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
  iss?: string
  sub?: string
  'https://api.openai.com/profile'?: { email?: string }
  'https://api.openai.com/auth'?: {
    chatgpt_account_user_id?: string
    chatgpt_user_id?: string
    user_id?: string
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

  const accountId = auth?.chatgpt_account_user_id
    ?? auth?.chatgpt_user_id
    ?? auth?.user_id
    ?? (payload.iss && payload.sub ? `${payload.iss}|${payload.sub}` : undefined)

  return {
    email: profile?.email,
    accountId,
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
  resolve: (result: OAuthLoginResult) => void
  reject: (error: Error) => void
  server: http.Server
  timeout: ReturnType<typeof setTimeout>
}

let pendingFlow: PendingOAuthFlow | null = null

/**
 * 启动回调服务器，等待 OAuth 回调
 * 返回 Promise，登录成功时 resolve
 */
export function waitForOAuthCallback(): Promise<OAuthLoginResult> {
  return new Promise((resolve, reject) => {
    const state = generateState()
    const codeVerifier = generateCodeVerifier()

    // 清理之前的 pending flow
    if (pendingFlow) {
      pendingFlow.server.close()
      clearTimeout(pendingFlow.timeout)
      pendingFlow.reject(new Error('Superseded by new login attempt'))
    }

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${OAUTH_CONFIG.callbackPort}`)

      if (url.pathname !== '/auth/callback') {
        res.writeHead(404)
        res.end('Not found')
        return
      }

      const code = url.searchParams.get('code')
      const returnedState = url.searchParams.get('state')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<html><body><h2>登录失败</h2><p>请关闭此窗口</p></body></html>')
        cleanup()
        reject(new Error(`OAuth error: ${error}`))
        return
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<html><body><h2>无效的回调</h2><p>请关闭此窗口并重试</p></body></html>')
        return
      }

      try {
        const tokenResult = await exchangeCodeForToken(code, codeVerifier)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<html><body><h2>登录成功！</h2><p>请关闭此窗口返回 Crabot</p></body></html>')
        cleanup()
        resolve(tokenResult)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<html><body><h2>Token 换取失败</h2><p>请关闭此窗口并重试</p></body></html>')
        cleanup()
        reject(err instanceof Error ? err : new Error(String(err)))
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

    server.listen(OAUTH_CONFIG.callbackPort, '127.0.0.1', () => {
      // Server ready
    })

    server.on('error', (err) => {
      cleanup()
      reject(new Error(`Failed to start callback server: ${err.message}`))
    })

    pendingFlow = {
      state,
      codeVerifier,
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
    redirect_uri: OAUTH_CONFIG.redirectUri,
    scope: OAUTH_CONFIG.scope,
    state: pendingFlow.state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })

  return `${OAUTH_CONFIG.authorizationEndpoint}?${params.toString()}`
}

// --- Token 换取 ---

async function exchangeCodeForToken(code: string, codeVerifier: string): Promise<OAuthLoginResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: OAUTH_CONFIG.clientId,
    redirect_uri: OAUTH_CONFIG.redirectUri,
    code_verifier: codeVerifier,
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
