#!/usr/bin/env node

// Crabot Stop — 跨平台优雅关闭所有服务（macOS / Linux / Windows）

import './_preflight.mjs'

import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'
import http from 'node:http'
import { readPid, clearPid, isPidAlive } from './lib/pid.mjs'
import { resolveCliDataDir } from './lib/instance.mjs'

// OFFSET / DATA_DIR 收敛到 resolveCliDataDir（OFFSET 走 env > instance.json > 0；
// DATA_DIR 走 env > 默认，不读 instance.data_dir）。
// 契约说明见 lib/instance.mjs:resolveCliDataDir。
const HOME_DIR = resolve(homedir(), '.crabot')
const DATA_DIR = resolveCliDataDir({ homeDir: HOME_DIR })
const OFFSET = parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)
const MM_PORT = 19000 + OFFSET
const ADMIN_RPC_PORT = 19001 + OFFSET
const WEB_PORT = 3000 + OFFSET
const IS_WIN = process.platform === 'win32'

const info = (msg) => console.log(`\x1b[32m[crabot]\x1b[0m ${msg}`)
const warn = (msg) => console.log(`\x1b[33m[crabot]\x1b[0m ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 杀 PID 及其所有子进程。Windows 用 taskkill /T 走进程树，
// 避免 MM 杀掉 Python 父进程后 uvicorn worker 变孤儿继续占端口。
function killTree(pid) {
  if (!pid) return
  try {
    if (IS_WIN) {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' })
    } else {
      execSync(`kill ${pid}`, { stdio: 'ignore' })
    }
  } catch { /* ok */ }
}

// 找占用指定 TCP 端口的 LISTENING PID 列表
function findPidsByPort(port) {
  try {
    if (IS_WIN) {
      // netstat 输出示例：
      //   TCP    127.0.0.1:19004        0.0.0.0:0              LISTENING       14180
      // state 字段在中英文 Windows 上均为英文 "LISTENING"
      const out = execSync('netstat -ano -p TCP', { encoding: 'utf-8' })
      const pids = new Set()
      const re = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(re)
        if (m && Number(m[1]) === port) pids.add(m[2])
      }
      return Array.from(pids)
    } else {
      const out = execSync(`lsof -ti :${port}`, { encoding: 'utf-8' }).trim()
      return out.split('\n').filter(Boolean)
    }
  } catch {
    return []
  }
}

// MM 是否还活着：用 MM_PORT 是否仍被 listen 判断（跨平台、无需进程枚举）
const isMmRunning = () => findPidsByPort(MM_PORT).length > 0

// 多端口合一查询：一次进程调用判定全部端口是否仍被占用（drain 轮询用，
// 避免每轮对每个端口各起一次 lsof/netstat）
function findPidsByPorts(ports) {
  const portList = Array.from(ports)
  if (portList.length === 0) return []
  try {
    if (IS_WIN) {
      const out = execSync('netstat -ano -p TCP', { encoding: 'utf-8' })
      const pids = new Set()
      const re = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i
      const wanted = new Set(portList)
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(re)
        if (m && wanted.has(Number(m[1]))) pids.add(m[2])
      }
      return Array.from(pids)
    } else {
      const args = portList.map((p) => `-ti :${p}`)
      const out = execSync(`lsof ${args.join(' ')}`, { encoding: 'utf-8' }).trim()
      return out.split('\n').filter(Boolean)
    }
  } catch {
    return []
  }
}

// 用 Node 内置 http 发 shutdown RPC，彻底绕开 curl 与 shell 引号差异
function shutdownRpc(port, timeoutMs = 5000) {
  return new Promise((res) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/shutdown',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
      timeout: timeoutMs,
    }, (resp) => {
      resp.resume()
      resp.on('end', () => res(true))
    })
    req.on('error', () => res(false))
    req.on('timeout', () => { req.destroy(); res(false) })
    req.end('{}')
  })
}

// ── 主流程 ──

info('Stopping Crabot...')

// 0. PID-first：如果有 mm.pid，先发 SIGTERM 给它（前台模式 = start 进程；后台模式 = supervisor）
const startPid = readPid(DATA_DIR)
if (startPid !== null && isPidAlive(startPid)) {
  info(`Sending SIGTERM to mm.pid=${startPid}...`)
  try { process.kill(startPid, 'SIGTERM') } catch { /* ok */ }
  // 等最多 15s（200ms 粒度轮询：收割通常 10-20s，粗粒度只会平白多等半个周期）
  for (let i = 0; i < 75; i++) {
    if (!isPidAlive(startPid)) break
    await sleep(200)
  }
}

// 1. 请 MM 优雅关闭（级联关闭所有子模块）
await shutdownRpc(MM_PORT)

// 2. 等 MM 退出
let waited = 0
while (isMmRunning() && waited < 15_000) {
  await sleep(200)
  waited += 200
}
if (isMmRunning()) {
  warn('Module Manager did not exit in 15s, force killing...')
}

// 3. Unix 上按命令行杀残留 Node 进程；Windows 由步骤 5 端口扫描兜底
if (!IS_WIN) {
  for (const pat of [
    'crabot-core/dist/main.js',
    'crabot-admin/dist/main.js',
    'crabot-agent/dist/main.js',
  ]) {
    try { execSync(`pkill -f "node.*${pat}"`, { stdio: 'ignore' }) } catch { /* ok */ }
  }
}

// 4. 清理 Chrome PID 文件
const chromePid = resolve(DATA_DIR, 'browser/chrome.pid')
if (existsSync(chromePid)) {
  try {
    killTree(readFileSync(chromePid, 'utf-8').trim())
    unlinkSync(chromePid)
  } catch { /* ok */ }
}

// 5. 端口兜底：MM + Admin RPC + Web + port-allocations.json 里所有动态分配的端口
//    先给仍在优雅退出途中的进程留收尾窗口：所有目标端口已空闲则立即继续，
//    否则每 200ms 复查（单次 lsof 覆盖全部端口），最长 2s。
const ports = new Set([MM_PORT, ADMIN_RPC_PORT, WEB_PORT])
const allocPath = resolve(DATA_DIR, 'port-allocations.json')
if (existsSync(allocPath)) {
  try {
    const allocs = JSON.parse(readFileSync(allocPath, 'utf-8'))
    for (const a of allocs) {
      if (typeof a?.port === 'number') ports.add(a.port)
    }
  } catch { /* ok */ }
}
const drainDeadline = Date.now() + 2000
for (;;) {
  if (findPidsByPorts(ports).length === 0) break
  if (Date.now() >= drainDeadline) break
  await sleep(200)
}
for (const port of ports) {
  for (const pid of findPidsByPort(port)) {
    killTree(pid)
  }
}

// 6. 清理 mm.pid 文件
clearPid(DATA_DIR)

info('Stopped.')
