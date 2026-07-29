#!/usr/bin/env node
// mock-cli.mjs — 测试用的假 cc/codex 进程,扮演其最小交互行为:每收到一行 stdin
// (对应 tmux sendText 注入的一行输入)就消费脚本的下一步。脚本经 env MOCK_CLI_SCRIPT 传入
// (JSON 数组,元素形如 { output？, emitStop？, exit？, exitCode？ })。
//
// 真实 cc 靠 .claude/settings.json 里配置的 Stop hook 命令来上报"我空闲了";真实 codex 靠
// config.toml 的 notify 程序上报 agent-turn-complete。mock 不解析 settings.json/config.toml,
// 而是直接执行 env MOCK_CLI_STOP_HOOK_CMD 传入的 hook/notify 命令本身(即
// CliEventChannel.hookCommand('stop') 的产物字符串)——效果等价,省去在 mock 里实现一个
// JSON/TOML 配置解析器。命令行参数(--session-id/--resume 等)默认原样忽略,除非设置了
// MOCK_CLI_ARGV_FILE(Task 5 resume 测试用它断言 --resume 参数确实被传下去了)。
//
// codex 专用:MOCK_CLI_ROLLOUT_FILE(可选,绝对路径)——真实 codex 在会话开始时会在
// `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-...-<uuid>.jsonl` 落一个 rollout 文件,codex
// adapter 的 spawn() 靠轮询发现这个文件名里的 uuid 来拿到会话真实 session_id(codex 没有
// 类似 cc `--session-id` 的入参,session id 由 codex 内部生成)。mock 在进入 stdin 循环前
// 同步创建这个文件(内容占位,发现逻辑只认文件名),模拟这一时序。
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import readline from 'node:readline'

const execAsync = promisify(exec)

const script = JSON.parse(process.env.MOCK_CLI_SCRIPT || '[]')
const stopHookCmd = process.env.MOCK_CLI_STOP_HOOK_CMD || ''

const argvFile = process.env.MOCK_CLI_ARGV_FILE
if (argvFile) appendFileSync(argvFile, JSON.stringify(process.argv.slice(2)) + '\n')

const rolloutFile = process.env.MOCK_CLI_ROLLOUT_FILE
if (rolloutFile) {
  mkdirSync(dirname(rolloutFile), { recursive: true })
  writeFileSync(rolloutFile, JSON.stringify({ type: 'session_meta', payload: { timestamp: new Date().toISOString() } }) + '\n')
}

let stepIndex = 0

async function runStep() {
  if (stepIndex >= script.length) return
  const step = script[stepIndex]
  stepIndex += 1

  if (step.output) process.stdout.write(step.output + '\n')

  if (step.emitStop && stopHookCmd) {
    try {
      await execAsync(stopHookCmd, { shell: '/bin/bash' })
    } catch (err) {
      process.stderr.write(`mock-cli: stop hook failed: ${err}\n`)
    }
  }

  if (step.exit) {
    process.exit(step.exitCode ?? 0)
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', () => {
  void runStep()
})
