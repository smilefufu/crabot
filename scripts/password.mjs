#!/usr/bin/env node

// Crabot Password — 修改管理员密码

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OFFSET = parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)
const DATA_DIR = process.env.DATA_DIR
  || (OFFSET > 0 ? resolve(ROOT, `data-${OFFSET}`) : resolve(ROOT, 'data'))

const adminDir = resolve(DATA_DIR, 'admin')
const adminEnvPath = resolve(adminDir, '.env')

mkdirSync(adminDir, { recursive: true })

// ── 读取密码 ──

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
  // 非 TTY
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

// ── 主流程 ──

const prompter = createPrompter()

const password = await prompter.ask('New admin password: ')
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

// 更新 .env 文件
let content = ''
if (existsSync(adminEnvPath)) {
  content = readFileSync(adminEnvPath, 'utf-8')
  if (content.includes('CRABOT_ADMIN_PASSWORD=')) {
    content = content.replace(/^CRABOT_ADMIN_PASSWORD=.*$/m, `CRABOT_ADMIN_PASSWORD=${password}`)
  } else {
    content = content.trimEnd() + `\nCRABOT_ADMIN_PASSWORD=${password}\n`
  }
} else {
  content = `CRABOT_ADMIN_PASSWORD=${password}\n`
}

writeFileSync(adminEnvPath, content)
console.log('[crabot] Password updated. Restart crabot for changes to take effect.')
