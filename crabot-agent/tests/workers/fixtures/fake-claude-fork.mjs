#!/usr/bin/env node
// fake-claude-fork.mjs — fork()/resume() 测试共用的假 cc 二进制。
//
// 两种调用形态都可能落到同一个 claudeBin(adapter 的 claudeBin 是单个字段,spawn 的 tmux
// 命令和 resume/fork 的子进程调用共享它):
//   ① 交互态(spawn/resume,tmux pane 里跑,无 `-p`):只管把 argv 记进 FAKE_ARGV_FILE(若设),
//      然后空转,不退出(避免 tmux 会话瞬间消亡)。
//   ② 无头一击(fork,`-p ...`):把 argv 记进 FAKE_ARGV_FILE,打印 FAKE_FORK_STDOUT,
//      以 FAKE_FORK_EXIT_CODE(默认 0)退出。
import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const argvFile = process.env.FAKE_ARGV_FILE
if (argvFile) appendFileSync(argvFile, JSON.stringify(argv) + '\n')

if (argv.includes('-p')) {
  const stdout = process.env.FAKE_FORK_STDOUT ?? ''
  if (stdout) process.stdout.write(stdout)
  process.exit(Number(process.env.FAKE_FORK_EXIT_CODE ?? '0'))
}

// 交互态:空转,等待测试结束后由 kill/进程回收清理。
setInterval(() => {}, 1_000_000)
