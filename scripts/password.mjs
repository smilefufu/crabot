#!/usr/bin/env node

// Crabot Password — 修改管理员密码

import './_preflight.mjs'

import { mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveDataDir } from './lib/data-dir.mjs'

const OFFSET = parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)
const DATA_DIR = resolveDataDir({ envValue: process.env.DATA_DIR, offset: OFFSET })

const adminDir = resolve(DATA_DIR, 'admin')
mkdirSync(adminDir, { recursive: true })

// 解析 credentials 模块路径（编译产物）
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const credModUrl = pathToFileURL(resolve(ROOT, 'crabot-admin/dist/credentials.js')).href
const { readCredentials, writeCredentials, rotateCredentials, newCredentialsFromPassword } =
  await import(credModUrl)

// ── 读取密码 ──

function createPrompter() {
  if (process.stdin.isTTY) {
    return {
      ask(prompt) {
        return new Promise((res) => {
          const previousRaw = process.stdin.isRaw
          let input = ''
          const cleanup = () => {
            process.stdin.setRawMode(previousRaw)
            process.stdin.removeListener('data', onData)
            process.stdin.pause()
          }
          const onData = (ch) => {
            for (const c of ch.toString()) {
              if (c === '\n' || c === '\r') {
                cleanup()
                process.stdout.write('\n')
                res(input)
                return
              } else if (c === '\x7f' || c === '\b') {
                if (input.length > 0) input = input.slice(0, -1)
              } else if (c === '\x03') {
                cleanup()
                process.exit(1)
              } else {
                input += c
              }
            }
          }
          try {
            process.stdin.setEncoding('utf8')
            process.stdin.setRawMode(true)
            process.stdin.on('data', onData)
            process.stdin.resume()
            process.stdout.write(prompt)
          } catch (error) {
            cleanup()
            throw error
          }
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

// 走 credentials 存储层（不依赖 admin 在跑）
const existing = await readCredentials(adminDir)
const newCred = existing
  ? await rotateCredentials(existing, password, 'cli')
  : await newCredentialsFromPassword(password, { is_temp: false, changed_via: 'cli' })
await writeCredentials(adminDir, newCred)

console.log('[crabot] Password updated. All existing login sessions are revoked.')
console.log('[crabot] (admin process picks up the change on the next login — no restart needed.)')
