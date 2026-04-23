#!/usr/bin/env node

// Crabot Start — 生产模式启动
// 加载环境变量 → 创建数据目录 → 密码检查 → 启动 Module Manager（前台）

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OFFSET = parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)

// ── 环境变量 ──

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return
  const lines = readFileSync(filePath, 'utf-8').split('\n')
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line || !line.includes('=')) continue
    const idx = line.indexOf('=')
    const key = line.slice(0, idx)
    const val = line.slice(idx + 1)
    if (!process.env[key]) {
      process.env[key] = val
    }
  }
}

const DATA_DIR = process.env.DATA_DIR
  || (OFFSET > 0 ? resolve(ROOT, `data-${OFFSET}`) : resolve(ROOT, 'data'))
process.env.DATA_DIR = DATA_DIR

loadEnvFile(resolve(DATA_DIR, 'admin/.env'))
loadEnvFile(resolve(ROOT, '.env'))

if (!process.env.CRABOT_JWT_SECRET) {
  process.env.CRABOT_JWT_SECRET = randomBytes(32).toString('hex')
}

// PATH 兜底：onboard/install 有些场景未持久化 ~/.local/bin 到 shell profile，
// 导致 Node spawn 子进程时找不到 uv。若该目录存在且未在 PATH 中，prepend 进去。
const LOCAL_BIN = resolve(homedir(), '.local/bin')
if (existsSync(LOCAL_BIN)) {
  const currentPath = (process.env.PATH || '').split(':').filter(Boolean)
  if (!currentPath.includes(LOCAL_BIN)) {
    process.env.PATH = [LOCAL_BIN, ...currentPath].join(':')
  }
}

// ── 数据目录 ──

for (const sub of ['admin', 'agent', 'memory']) {
  mkdirSync(resolve(DATA_DIR, sub), { recursive: true })
}

// ── 密码检查 ──

const adminEnvPath = resolve(DATA_DIR, 'admin/.env')

if (!process.env.CRABOT_ADMIN_PASSWORD) {
  const prompter = createPrompter()
  const password = await prompter.ask('Set admin password: ')
  if (!password || password.length < 4) {
    console.error('[crabot] Password must be at least 4 characters.')
    process.exit(1)
  }
  const confirm = await prompter.ask('Confirm password: ')
  prompter.close()
  if (password !== confirm) {
    console.error('[crabot] Passwords do not match.')
    process.exit(1)
  }
  const line = `CRABOT_ADMIN_PASSWORD=${password}\n`
  writeFileSync(adminEnvPath, existsSync(adminEnvPath) ? readFileSync(adminEnvPath, 'utf-8') + line : line)
  process.env.CRABOT_ADMIN_PASSWORD = password
  console.log('[crabot] Password saved.')
}

// ── 启动 Module Manager ──

const mmEntry = resolve(ROOT, 'crabot-core/dist/main.js')
if (!existsSync(mmEntry)) {
  console.error('[crabot] crabot-core/dist/main.js not found. Run build first.')
  process.exit(1)
}

const MM_PORT = 19000 + OFFSET
const WEB_PORT = 3000 + OFFSET

console.log(`[crabot] Starting Module Manager (port ${MM_PORT})...`)
console.log(`[crabot] Admin Web: http://localhost:${WEB_PORT}`)

const child = spawn(process.execPath, [mmEntry], {
  cwd: resolve(ROOT, 'crabot-core'),
  stdio: 'inherit',
  env: { ...process.env },
})

child.on('exit', (code) => {
  process.exit(code ?? 1)
})

// 转发信号，优雅关闭
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig))
}

// ── 辅助函数 ──

function createPrompter() {
  if (process.stdin.isTTY) {
    return {
      ask(prompt) {
        return new Promise((res) => {
          process.stdout.write(prompt)
          process.stdin.setRawMode(true)
          process.stdin.resume()
          let input = ''
          const onData = (ch) => {
            const c = ch.toString()
            if (c === '\n' || c === '\r') {
              process.stdin.setRawMode(false)
              process.stdin.removeListener('data', onData)
              process.stdin.pause()
              process.stdout.write('\n')
              res(input)
            } else if (c === '\x7f' || c === '\b') {
              if (input.length > 0) input = input.slice(0, -1)
            } else if (c === '\x03') {
              process.exit(1)
            } else {
              input += c
            }
          }
          process.stdin.on('data', onData)
        })
      },
      close() {},
    }
  }
  const rl = createInterface({ input: process.stdin })
  const lines = []
  let waiting = null
  let closed = false
  rl.on('line', (line) => {
    if (waiting) { const cb = waiting; waiting = null; cb(line) }
    else lines.push(line)
  })
  rl.on('close', () => {
    closed = true
    if (waiting) { const cb = waiting; waiting = null; cb('') }
  })
  return {
    ask(prompt) {
      process.stdout.write(prompt)
      if (lines.length > 0) return Promise.resolve(lines.shift())
      if (closed) return Promise.resolve('')
      return new Promise((res) => { waiting = res })
    },
    close() { rl.close() },
  }
}
