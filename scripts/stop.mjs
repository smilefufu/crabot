#!/usr/bin/env node

// Crabot Stop — 优雅关闭所有服务

import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OFFSET = parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)
const MM_PORT = 19000 + OFFSET
const DATA_DIR = process.env.DATA_DIR
  || (OFFSET > 0 ? resolve(ROOT, `data-${OFFSET}`) : resolve(ROOT, 'data'))

const info = (msg) => console.log(`\x1b[32m[crabot]\x1b[0m ${msg}`)
const warn = (msg) => console.log(`\x1b[33m[crabot]\x1b[0m ${msg}`)

// 1. 优雅关闭 Module Manager（级联关闭所有子模块）
info('Stopping Crabot...')
try {
  execSync(
    `curl --noproxy '*' -s -X POST "http://localhost:${MM_PORT}/shutdown" -H "Content-Type: application/json" -d '{}'`,
    { timeout: 5000, stdio: 'ignore' },
  )
} catch {
  // MM 可能已停
}

// 2. 等待进程退出
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isRunning = () => {
  try {
    execSync('pgrep -f "crabot-core/dist/main.js"', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let waited = 0
while (isRunning() && waited < 15) {
  await sleep(1000)
  waited++
}
if (isRunning()) {
  warn('Module Manager did not exit in 15s, force killing...')
}

// 3. 杀残留进程
for (const pat of ['crabot-core/dist/main.js', 'crabot-admin/dist/main.js', 'crabot-agent/dist/main.js']) {
  try { execSync(`pkill -f "node.*${pat}"`, { stdio: 'ignore' }) } catch { /* ok */ }
}

// 4. 清理 Chrome PID
const chromePid = resolve(DATA_DIR, 'browser/chrome.pid')
if (existsSync(chromePid)) {
  try { execSync(`kill ${readFileSync(chromePid, 'utf-8').trim()}`, { stdio: 'ignore' }) } catch { /* ok */ }
  unlinkSync(chromePid)
}

// 5. 释放端口
await sleep(2000)
const ports = [19000 + OFFSET, 19001 + OFFSET, 3000 + OFFSET]
for (const port of ports) {
  try {
    const pids = execSync(`lsof -ti :${port}`, { encoding: 'utf-8' }).trim()
    for (const pid of pids.split('\n').filter(Boolean)) {
      try { execSync(`kill ${pid}`, { stdio: 'ignore' }) } catch { /* ok */ }
    }
  } catch { /* ok */ }
}

info('Stopped.')
