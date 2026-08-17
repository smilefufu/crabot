#!/usr/bin/env node

/**
 * 后台 supervisor：被 `crabot start -d` 父进程 spawn(detached) 出来。
 * 职责：
 *   1. 起 rotating-file-stream（stdout/stderr 各一份）
 *   2. spawn MM，pipe stdio 到 rotating streams
 *   3. MM 退出 → 清理 mm.pid → 自己退出
 *   4. 收到 SIGTERM → kill MM → 等退出 → 清理 → 退出
 *
 * 输入：env CRABOT_SUPERVISOR_DATA_DIR、CRABOT_SUPERVISOR_MM_ENTRY、CRABOT_SUPERVISOR_MM_CWD
 */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createStream } from 'rotating-file-stream'
import { clearPid } from './lib/pid.mjs'
import { createSupervisorShutdownController } from './lib/supervisor-shutdown.mjs'

const DATA_DIR = process.env.CRABOT_SUPERVISOR_DATA_DIR
const MM_ENTRY = process.env.CRABOT_SUPERVISOR_MM_ENTRY
const MM_CWD = process.env.CRABOT_SUPERVISOR_MM_CWD

if (!DATA_DIR || !MM_ENTRY || !MM_CWD) {
  console.error('supervisor: missing env vars')
  process.exit(2)
}

const LOG_DIR = resolve(DATA_DIR, 'logs')
mkdirSync(LOG_DIR, { recursive: true })

const ROTATE_OPTS = { size: '10M', maxFiles: 5 }
const stdoutStream = createStream('mm.stdout.log', { path: LOG_DIR, ...ROTATE_OPTS })
const stderrStream = createStream('mm.stderr.log', { path: LOG_DIR, ...ROTATE_OPTS })

const startedAt = new Date().toISOString()
stdoutStream.write(`[supervisor] started at ${startedAt}, pid=${process.pid}\n`)

const mm = spawn(process.execPath, [MM_ENTRY], {
  cwd: MM_CWD,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
})

mm.stdout.pipe(stdoutStream)
mm.stderr.pipe(stderrStream)

let exiting = false
const cleanup = (exitCode) => {
  if (exiting) return
  exiting = true
  clearPid(DATA_DIR)
  stdoutStream.end()
  stderrStream.end()
  process.exit(exitCode)
}

const shutdownController = createSupervisorShutdownController({
  mm,
  cleanup,
  log: message => stdoutStream.write(message),
})

mm.on('exit', (code, signal) => {
  stdoutStream.write(`[supervisor] MM exited code=${code} signal=${signal}\n`)
  shutdownController.handleMmExit(code ?? 0)
})

mm.on('error', (err) => {
  stderrStream.write(`[supervisor] MM spawn error: ${err.message}\n`)
  shutdownController.handleMmExit(1)
})

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => shutdownController.handleSignal(sig))
}
