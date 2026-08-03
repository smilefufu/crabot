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

const argv = process.argv.slice(2)
const argvFile = process.env.FAKE_ARGV_FILE
if (argvFile) appendFileSync(argvFile, JSON.stringify(argv) + '\n')

if (argv.includes('-p')) {
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
  if (stdout) process.stdout.write(stdout)
  process.exit(Number(process.env.FAKE_FORK_EXIT_CODE ?? '0'))
}

// 交互态:空转,等待测试结束后由 kill/进程回收清理。
setInterval(() => {}, 1_000_000)
