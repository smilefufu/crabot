import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Session } from 'electron'
import { isAppUrl } from './window-security.js'

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json' }
const routes = /^\/(?:chat|workspaces|providers|modules|agents|channels|migrate|backup|settings|memory|dialog-objects|friends|permission-templates|mcp-servers|skills|subagents|traces|sessions|schedules|login|setup-password|desktop)(?:\/[^.]*)?$/
export function attachLocalPages(session: Session, directory: string) {
  session.protocol.handle('app', async request => {
    if (!isAppUrl(request.url) || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 403 })
    try {
      const url = new URL(request.url), root = await realpath(directory)
      const pathname = decodeURIComponent(url.pathname)
      if (pathname.includes('\0') || pathname.includes('\\')) return new Response(null, { status: 400 })
      const relative = pathname === '/' || routes.test(pathname) ? 'desktop.html' : pathname.replace(/^\/+/, '')
      const file = await realpath(path.join(root, relative)), location = path.relative(root, file)
      if (location.startsWith('..') || path.isAbsolute(location) || !(await stat(file)).isFile()) return new Response(null, { status: 403 })
      return new Response(request.method === 'HEAD' ? null : await readFile(file), { headers: {
        'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http://127.0.0.1:* http://[::1]:*; media-src 'self' blob: http://127.0.0.1:* http://[::1]:*; connect-src 'self' http://127.0.0.1:* http://[::1]:* ws://127.0.0.1:* ws://[::1]:*; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
        'Cache-Control': 'no-store',
      } })
    } catch { return new Response('本地界面资源无法读取，请修复安装。', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }) }
  })
}
