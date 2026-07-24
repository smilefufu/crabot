import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

/**
 * 把 /tmp-pages/* 请求纯透明转发到 127.0.0.1:<port>（agent 起的 tmp-page server）。
 * 不鉴权（匿名访问）。目标地址硬编码 127.0.0.1 + 固定端口，URL 不参与上游决策（无 SSRF）。
 */
export function proxyTmpPage(
  req: IncomingMessage,
  res: ServerResponse,
  tmpPagePort: number,
): Promise<void> {
  return new Promise((resolve) => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: tmpPagePort,
        method: req.method,
        path: req.url,
        headers: req.headers,
        timeout: 10_000,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(res)
        upRes.on('end', () => resolve())
        // 上游响应头已写出后中途断连：销毁下游连接，避免未处理的 error 冒泡
        upRes.on('error', () => { res.destroy(); resolve() })
      },
    )
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' })
      }
      res.end('<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem">'
        + '<h2>页面已失效或服务未启动</h2></body></html>')
      resolve()
    })
    upstream.on('timeout', () => upstream.destroy())
    req.pipe(upstream)
  })
}

/**
 * 判断路径是否命中 _manage 管理端点（应仅 agent 本机直连 127.0.0.1:<port>，不经公网反代）。
 * 必须先归一化连续斜杠再判：否则 `/tmp-pages//_manage/list` 这类绕过——admin 守卫漏判 →
 * 照常反代 → server.cjs 用 split('/').filter(Boolean) 折叠空段后仍命中 _manage → 匿名枚举/删除泄露。
 */
export function isManagePath(pathname: string): boolean {
  return pathname.replace(/\/{2,}/g, '/').startsWith('/tmp-pages/_manage')
}

export interface EnsureTmpPageServerOpts {
  serverScriptPath: string
  dataDir: string
  port: number
  startupTimeoutMs?: number
  probeIntervalMs?: number
}

const ensureInFlight = new Map<string, Promise<void>>()

function probeLocalPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (open: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(500, () => done(false))
  })
}

/**
 * 幂等拉起 tmp-page server（spec 2026-07-24-tmp-page-availability-design.md §5.2）。
 * 与 agent 侧 tmp-page-tools.ts 的 ensureTmpPageServer 同构——两包无共享依赖，有意重复。
 * spawn env 的 DATA_DIR/CRABOT_TMP_PAGE_PORT 必须与反代目标一致（两侧拉起等价的不变量）。
 */
export async function ensureTmpPageServer(opts: EnsureTmpPageServerOpts): Promise<void> {
  if (!existsSync(opts.serverScriptPath)) throw new Error('tmp-page server script unavailable')
  if (await probeLocalPort(opts.port)) return
  const key = `${opts.serverScriptPath}:${opts.dataDir}:${opts.port}`
  const pending = ensureInFlight.get(key)
  if (pending) return pending
  const promise = startTmpPageServer(opts).finally(() => { ensureInFlight.delete(key) })
  ensureInFlight.set(key, promise)
  return promise
}

function startTmpPageServer(opts: EnsureTmpPageServerOpts): Promise<void> {
  const timeoutMs = opts.startupTimeoutMs ?? 5_000
  const probeIntervalMs = opts.probeIntervalMs ?? 50
  const logDir = path.join(opts.dataDir, 'logs')
  mkdirSync(logDir, { recursive: true })
  const logFd = openSync(path.join(logDir, 'tmp-page-server.log'), 'a')

  return new Promise((resolve, reject) => {
    let settled = false
    let childExited = false
    const timer = setTimeout(() => finish(new Error('tmp-page server startup timed out')), timeoutMs)
    const interval = setInterval(() => {
      void probeLocalPort(opts.port).then((open) => {
        if (open) finish()
        else if (childExited) finish(new Error('tmp-page server exited before listening'))
      })
    }, probeIntervalMs)

    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(interval)
      if (err) reject(err)
      else resolve()
    }

    let child
    try {
      child = spawn(process.execPath, [opts.serverScriptPath], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: {
          ...process.env,
          DATA_DIR: opts.dataDir,
          CRABOT_TMP_PAGE_PORT: String(opts.port),
        },
      })
    } catch (err) {
      closeSync(logFd)
      finish(err instanceof Error ? err : new Error(String(err)))
      return
    }
    closeSync(logFd)

    child.once('error', (err) => finish(err))
    child.once('exit', () => {
      childExited = true
      void probeLocalPort(opts.port).then((open) => {
        if (open) finish() // EADDRINUSE 幂等退出：别人已在跑
      })
    })
    child.unref()
  })
}

/**
 * /tmp-pages/* 请求的完整处理：_manage 守卫 → 幂等拉起 server → 透明转发。
 * 守卫必须在 ensure 之前（管理端点永不经反代，也不该为它拉起 server）。
 * ensure 失败只记日志并继续转发——转发对不可达上游自会回 502 现文案。
 */
export async function handleTmpPageRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  opts: EnsureTmpPageServerOpts,
): Promise<void> {
  if (isManagePath(pathname)) {
    res.writeHead(404)
    res.end(JSON.stringify({ error: 'Not found' }))
    return
  }
  try {
    await ensureTmpPageServer(opts)
  } catch (err) {
    console.error(JSON.stringify({
      type: 'tmp-page-ensure-failed',
      error: err instanceof Error ? err.message : String(err),
    }))
  }
  return proxyTmpPage(req, res, opts.port)
}

/** 解析对外 base URL：优先用全局设置的 public_base_url，去尾斜杠；未配置退化为本地 web 地址 */
export function resolveTmpPageBaseUrl(
  publicBaseUrl: string | undefined,
  webPort: number,
): string {
  if (publicBaseUrl && publicBaseUrl.trim()) {
    return publicBaseUrl.trim().replace(/\/+$/, '')
  }
  return `http://localhost:${webPort}`
}
