const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = parseInt(process.env.CRABOT_TMP_PAGE_PORT || '19099', 10)
const HOST = '127.0.0.1'
const DATA_DIR = process.env.DATA_DIR || process.cwd()
const PAGES_DIR = path.join(DATA_DIR, 'tmp-pages')
const IDLE_TIMEOUT_MS = 30 * 60 * 1000
const TTL_SWEEP_MS = 5 * 60 * 1000
const MAX_SUBMIT_BYTES = 64 * 1024

const helperScript = fs.readFileSync(path.join(__dirname, 'helper.js'), 'utf-8')
const helperInjection = '\n<script>\n' + helperScript + '\n</script>\n'

let lastActivity = Date.now()
const touch = () => { lastActivity = Date.now() }

function pageDir(id) {
  // page_id 白名单：仅 hex/字母数字下划线，防路径穿越
  if (!/^[A-Za-z0-9_-]{16,}$/.test(id)) return null
  return path.join(PAGES_DIR, id)
}

function readMeta(id) {
  try { return JSON.parse(fs.readFileSync(path.join(pageDir(id), 'meta.json'), 'utf-8')) }
  catch { return null }
}

function isExpired(meta) {
  return meta && meta.expires_at && Date.now() > new Date(meta.expires_at).getTime()
}

function sweepExpired() {
  if (!fs.existsSync(PAGES_DIR)) return
  for (const id of fs.readdirSync(PAGES_DIR)) {
    const meta = readMeta(id)
    if (isExpired(meta)) {
      fs.rmSync(path.join(PAGES_DIR, id), { recursive: true, force: true })
      console.log(JSON.stringify({ type: 'page-expired', id }))
    }
  }
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' })
  res.end(body)
}

function handle(req, res) {
  touch()
  const url = new URL(req.url, `http://${req.headers.host}`)
  const parts = url.pathname.split('/').filter(Boolean) // ['tmp-pages', '<id>', ...]

  // 管理端点：GET /tmp-pages/_manage/list, DELETE /tmp-pages/_manage/<id>
  if (parts[1] === '_manage') {
    if (parts[2] === 'list' && req.method === 'GET') {
      const list = fs.existsSync(PAGES_DIR)
        ? fs.readdirSync(PAGES_DIR).map((id) => ({ id, ...readMeta(id) })).filter((m) => m.created_at)
        : []
      return send(res, 200, 'application/json', JSON.stringify(list))
    }
    if (req.method === 'DELETE' && parts[2]) {
      const dir = pageDir(parts[2])
      if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
      return send(res, 200, 'application/json', JSON.stringify({ ok: true }))
    }
    return send(res, 404, 'text/plain', 'not found')
  }

  const id = parts[1]
  const dir = id ? pageDir(id) : null
  if (!dir || !fs.existsSync(dir)) return send(res, 404, 'text/html', '<h2>页面不存在</h2>')
  const meta = readMeta(id)
  if (isExpired(meta)) {
    fs.rmSync(dir, { recursive: true, force: true })
    return send(res, 404, 'text/html', '<h2>页面已过期</h2>')
  }

  // 提交反馈：POST /tmp-pages/<id>/submit
  if (parts[2] === 'submit' && req.method === 'POST') {
    let body = ''
    let tooBig = false
    req.on('data', (c) => {
      if (tooBig) return
      body += c
      if (body.length > MAX_SUBMIT_BYTES) {
        tooBig = true
        send(res, 413, 'application/json', JSON.stringify({ error: 'payload too large' }))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooBig) return
      const line = JSON.stringify({ at: new Date().toISOString(), data: safeParse(body) }) + '\n'
      fs.appendFileSync(path.join(dir, 'events.jsonl'), line)
      // 反馈已落盘，先回 200；再尝试唤醒 owner task（缺失跳过、失败只记日志，不阻塞返回）
      send(res, 200, 'application/json', JSON.stringify({ ok: true }))
      wakeOwnerTask(meta && meta.owner_task_id, id)
    })
    return
  }

  // 取页面：GET /tmp-pages/<id>
  if (req.method === 'GET') {
    let html = fs.readFileSync(path.join(dir, 'page.html'), 'utf-8')
    html = html.includes('</body>')
      ? html.replace('</body>', helperInjection + '</body>')
      : html + helperInjection
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self' 'unsafe-inline' data:; connect-src 'self'",
    })
    return res.end(html)
  }

  send(res, 404, 'text/plain', 'not found')
}

function safeParse(s) { try { return JSON.parse(s) } catch { return s } }

// 经 MM RPC 唤醒 owner task：先 resolve agent 端口，再 POST deliver_page_feedback。
// owner_task_id 缺失直接跳过；任一步失败只 console.error，不影响 submit 已返回的 200（反馈已落盘 events.jsonl）。
function rpc(port, method, params) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      id: `tmp-page-${Date.now()}`,
      source: 'tmp-page-server',
      method,
      params,
      timestamp: new Date().toISOString(),
    })
    const req = http.request(
      { hostname: 'localhost', port, method: 'POST', path: `/${method}`, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (r) => {
        let data = ''
        r.on('data', (c) => { data += c })
        r.on('end', () => { try { resolve(JSON.parse(data)) } catch { resolve(null) } })
      },
    )
    req.on('error', () => resolve(null))
    req.write(body)
    req.end()
  })
}

async function wakeOwnerTask(taskId, pageId) {
  if (!taskId || !pageId) return
  try {
    const mmPort = parseInt(process.env.CRABOT_MM_PORT || '19000', 10)
    const resolved = await rpc(mmPort, 'resolve', { module_type: 'agent' })
    const agent = resolved && resolved.success && resolved.data && resolved.data.modules && resolved.data.modules.find((m) => m.port)
    if (!agent) {
      console.error(JSON.stringify({ type: 'wake-failed', task_id: taskId, page_id: pageId, reason: 'agent-unresolved' }))
      return
    }
    await rpc(agent.port, 'deliver_page_feedback', { task_id: taskId, page_id: pageId })
  } catch (err) {
    // 反馈已落盘 events.jsonl，唤醒尽力而为：只记日志，不影响 submit 已返回的 200
    console.error(JSON.stringify({ type: 'wake-failed', task_id: taskId, page_id: pageId, error: err && err.message }))
  }
}

if (!fs.existsSync(PAGES_DIR)) fs.mkdirSync(PAGES_DIR, { recursive: true })
const server = http.createServer(handle)

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(JSON.stringify({ type: 'already-running', port: PORT }))
    process.exit(0) // 幂等：已有 server 在跑
  }
  console.error('server error:', err.message)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ type: 'server-started', port: PORT, pages_dir: PAGES_DIR }))
})

setInterval(sweepExpired, TTL_SWEEP_MS).unref()
const idleCheck = setInterval(() => {
  if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
    console.log(JSON.stringify({ type: 'idle-exit' }))
    server.close(() => process.exit(0))
  }
}, 60 * 1000)
idleCheck.unref()
