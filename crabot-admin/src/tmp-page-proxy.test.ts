import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { proxyTmpPage, isManagePath, ensureTmpPageServer } from './tmp-page-proxy'

describe('isManagePath', () => {
  it('命中 _manage 端点', () => {
    expect(isManagePath('/tmp-pages/_manage/list')).toBe(true)
    expect(isManagePath('/tmp-pages/_manage')).toBe(true)
  })
  it('堵住连续斜杠绕过（与 server.cjs 折叠空段对齐）', () => {
    expect(isManagePath('/tmp-pages//_manage/list')).toBe(true)
    expect(isManagePath('/tmp-pages///_manage/abc')).toBe(true)
  })
  it('放行普通 page 路径', () => {
    expect(isManagePath('/tmp-pages/abcdef0123456789')).toBe(false)
    expect(isManagePath('/tmp-pages/abcdef0123456789/submit')).toBe(false)
  })
})

let upstream: http.Server, front: http.Server
let upstreamPort: number, frontPort: number

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let b = ''; req.on('data', (c) => (b += c))
      req.on('end', () => { res.writeHead(200); res.end(JSON.stringify({ got: b })) })
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>hello</h1>')
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  upstreamPort = (upstream.address() as { port: number }).port

  front = http.createServer((req, res) => {
    const target = req.url?.startsWith('/dead') ? 1 : upstreamPort
    void proxyTmpPage(req, res, target)
  })
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r))
  frontPort = (front.address() as { port: number }).port
})

afterAll(() => { upstream.close(); front.close() })

describe('proxyTmpPage', () => {
  it('转发 GET 并回传上游 body', async () => {
    const r = await fetch(`http://127.0.0.1:${frontPort}/tmp-pages/abc`)
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('hello')
  })
  it('转发 POST body', async () => {
    const r = await fetch(`http://127.0.0.1:${frontPort}/tmp-pages/abc/submit`,
      { method: 'POST', body: '{"x":1}' })
    expect(await r.json()).toEqual({ got: '{"x":1}' })
  })
  it('上游不可达 → 502', async () => {
    const r = await fetch(`http://127.0.0.1:${frontPort}/dead`)
    expect(r.status).toBe(502)
    expect(await r.text()).toContain('失效')
  })
})

async function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
}

/** 写一个自记录、自终结的假 server 脚本;spawn 时把 env 记到 spawn.log */
function writeFakeServerScript(dir: string): string {
  const script = `
const fs = require('fs'); const http = require('http'); const path = require('path')
const port = parseInt(process.env.CRABOT_TMP_PAGE_PORT, 10)
fs.appendFileSync(path.join(__dirname, 'spawn.log'),
  JSON.stringify({ data_dir: process.env.DATA_DIR, port: process.env.CRABOT_TMP_PAGE_PORT }) + '\\n')
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>revived</h1>')
})
server.on('error', (e) => process.exit(e.code === 'EADDRINUSE' ? 0 : 1))
server.listen(port, '127.0.0.1')
setTimeout(() => process.exit(0), 8000)
`
  const p = path.join(dir, 'fake-server.cjs')
  fs.writeFileSync(p, script)
  return p
}

describe('ensureTmpPageServer', () => {
  it('端口未开 → 拉起假 server 并等到就绪;再次调用走快路径不重复 spawn', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-page-ensure-'))
    const scriptPath = writeFakeServerScript(dir)
    const port = await getFreePort()
    const opts = { serverScriptPath: scriptPath, dataDir: dir, port }

    await ensureTmpPageServer(opts)
    const r = await fetch(`http://127.0.0.1:${port}/tmp-pages/x`)
    expect(await r.text()).toContain('revived')

    await ensureTmpPageServer(opts) // 端口已开,快路径
    const lines = fs.readFileSync(path.join(dir, 'spawn.log'), 'utf8').trim().split('\n')
    expect(lines.length).toBe(1)
  })

  it('spawn env 含一致的 DATA_DIR 与 CRABOT_TMP_PAGE_PORT', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-page-env-'))
    const scriptPath = writeFakeServerScript(dir)
    const port = await getFreePort()
    await ensureTmpPageServer({ serverScriptPath: scriptPath, dataDir: dir, port })
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'spawn.log'), 'utf8').trim())
    expect(rec.data_dir).toBe(dir)
    expect(rec.port).toBe(String(port))
  })

  it('脚本缺失 → reject', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-page-miss-'))
    const port = await getFreePort()
    await expect(ensureTmpPageServer({
      serverScriptPath: path.join(dir, 'nope.cjs'), dataDir: dir, port,
    })).rejects.toThrow()
  })

  it('并发调用共享同一次拉起,只 spawn 一次', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-page-conc-'))
    const scriptPath = writeFakeServerScript(dir)
    const port = await getFreePort()
    const opts = { serverScriptPath: scriptPath, dataDir: dir, port }
    await Promise.all([1, 2, 3, 4, 5].map(() => ensureTmpPageServer(opts)))
    const lines = fs.readFileSync(path.join(dir, 'spawn.log'), 'utf8').trim().split('\n')
    expect(lines.length).toBe(1)
  })
})
