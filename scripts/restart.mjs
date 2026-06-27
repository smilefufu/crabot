#!/usr/bin/env node

import './_preflight.mjs'

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { resolveCliDataDir } from './lib/instance.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CRABOT_HOME = resolve(__dirname, '..')
const CLI = join(CRABOT_HOME, 'cli.mjs')
const DATA_DIR = resolveCliDataDir({ homeDir: resolve(homedir(), '.crabot'), repoRoot: CRABOT_HOME })
const STATUS_DIR = join(DATA_DIR, 'admin')
const STATUS_FILE = join(STATUS_DIR, 'restart-status.json')

function writeStatus(patch) {
  mkdirSync(STATUS_DIR, { recursive: true })
  let prev = {}
  if (existsSync(STATUS_FILE)) {
    try { prev = JSON.parse(readFileSync(STATUS_FILE, 'utf-8')) } catch {}
  }
  writeFileSync(STATUS_FILE, JSON.stringify({ ...prev, ...patch }, null, 2))
}

function node(args) {
  execFileSync(process.execPath, [CLI, ...args], { cwd: CRABOT_HOME, stdio: 'inherit' })
}

function stamp() {
  return new Date().toISOString()
}

async function main() {
  const reason = process.env.CRABOT_RESTART_REASON || undefined
  console.log(`[restart] start reason=${reason ?? '-'} at=${stamp()}`)
  writeStatus({ phase: 'restarting', started_at: stamp(), reason, finished_at: undefined, error: undefined })

  try {
    console.log('[restart] stop')
    node(['stop'])
    console.log('[restart] start -d')
    node(['start', '-d'])
    writeStatus({ phase: 'done', finished_at: stamp() })
    console.log(`[restart] done at=${stamp()}`)
  } catch (err) {
    const msg = err?.message || String(err)
    console.error('[restart] FAILED:', msg)
    writeStatus({ phase: 'failed', error: msg, finished_at: stamp() })
    process.exit(1)
  }
}

main().catch((err) => {
  const msg = err?.message || String(err)
  writeStatus({ phase: 'failed', error: msg, finished_at: stamp() })
  process.exit(1)
})
