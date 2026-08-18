#!/usr/bin/env node
// fake-claude-fork.mjs — fork()/resume() 测试共用的假 cc 二进制。
//
// 两种调用形态都可能落到同一个 claudeBin(adapter 的 claudeBin 是单个字段,spawn 的 tmux
// 命令和 resume/fork 的子进程调用共享它):
//   ① 交互态(spawn/resume,tmux pane 里跑,无 `-p`):只管把 argv 记进 FAKE_ARGV_FILE(若设),
//      然后空转,不退出(避免 tmux 会话瞬间消亡)。
//   ② 无头一击(fork,`-p ...`):把 argv 记进 FAKE_ARGV_FILE,打印 FAKE_FORK_STDOUT,
//      以 FAKE_FORK_EXIT_CODE(默认 0)退出。
//
// FAKE_FORK_RUN_STOP_HOOK=1(可选,只在无头形态生效):复刻"真实 cc 在 print 模式同样执行
// workspace 级 .claude/settings.json 里的 Stop hook"这一事实——从 cwd 读 settings.json,
// 用 /bin/sh 跑那条 hook 命令(env 原样继承给子进程,与 cc 拉起 hook 的方式一致)。
import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const argv = process.argv.slice(2)
const argvFile = process.env.FAKE_ARGV_FILE
if (argvFile) appendFileSync(argvFile, JSON.stringify(argv) + '\n')

if (argv.includes('-p')) {
  const terminationFile = process.env.FAKE_FORK_TERMINATION_FILE
  process.on('SIGTERM', () => {
    if (terminationFile) appendFileSync(terminationFile, `${process.pid}:SIGTERM\n`)
    process.exit(0)
  })
  if (process.env.FAKE_FORK_RUN_STOP_HOOK === '1') {
    try {
      const settings = JSON.parse(readFileSync(join(process.cwd(), '.claude', 'settings.json'), 'utf-8'))
      const command = settings?.hooks?.Stop?.[0]?.hooks?.[0]?.command
      if (command) execFileSync('/bin/sh', ['-c', command], { stdio: 'ignore' })
    } catch (err) {
      process.stderr.write(`fake-claude-fork: stop hook failed: ${err}\n`)
    }
  }
  const stdout = process.env.FAKE_FORK_STDOUT ?? ''
  if (argv.includes('stream-json')) {
    const sessionId = process.env.FAKE_FORK_SESSION_ID ?? randomUUID()
    if (process.env.FAKE_FORK_SKIP_INIT === '1') {
      process.stdout.write(JSON.stringify({ type: 'result', result: stdout }) + '\n')
      process.exit(Number(process.env.FAKE_FORK_EXIT_CODE ?? '0'))
    }
    const emitInit = () => {
      process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n')
      setTimeout(() => {
        if (stdout) {
          process.stdout.write(JSON.stringify({
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text: stdout } },
          }) + '\n')
        }
        process.stdout.write(JSON.stringify({
          type: 'result',
          result: process.env.FAKE_FORK_RESULT ?? stdout,
        }) + '\n')
        process.exit(Number(process.env.FAKE_FORK_EXIT_CODE ?? '0'))
      }, Number(process.env.FAKE_FORK_DELAY_AFTER_INIT_MS ?? '0'))
    }
    setTimeout(emitInit, Number(process.env.FAKE_FORK_INIT_DELAY_MS ?? '0'))
  } else if (stdout) {
    process.stdout.write(stdout)
    process.exit(Number(process.env.FAKE_FORK_EXIT_CODE ?? '0'))
  }
}

if (!argv.includes('-p')) {
  // 交互态:先请求 bracketed paste(真实 cc/codex TUI 启动时都会发这个 DECSET 2004 序列),
  // 再空转等测试结束后由 kill/进程回收清理。adapter 的启动期就绪握手等的正是这个信号——
  // 不发的话每次 spawn 都要白等一次握手超时(见 src/workers/tmux/paste-ready.ts)。
  process.stdout.write('\x1b[?2004h')
  setInterval(() => {}, 1_000_000)
}
