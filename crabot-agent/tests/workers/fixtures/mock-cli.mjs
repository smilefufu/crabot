#!/usr/bin/env node
// mock-cli.mjs — 测试用的假 cc 进程,扮演 claude code 的最小交互行为:每收到一行 stdin
// (对应 tmux sendText 注入的一行输入)就消费脚本的下一步。脚本经 env MOCK_CLI_SCRIPT 传入
// (JSON 数组,元素形如 { output？, emitStop？, exit？, exitCode？ })。
//
// 真实 cc 靠 .claude/settings.json 里配置的 Stop hook 命令来上报"我空闲了";mock 不解析
// settings.json,而是直接执行 env MOCK_CLI_STOP_HOOK_CMD 传入的 hook 命令本身(即
// CliEventChannel.hookCommand('stop') 的产物字符串)——效果等价,省去在 mock 里实现一个
// JSON 配置解析器。命令行参数(--session-id/--resume 等)默认原样忽略,除非设置了
// MOCK_CLI_ARGV_FILE(Task 5 resume 测试用它断言 --resume 参数确实被传下去了)。
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const execAsync = promisify(exec)

const script = JSON.parse(process.env.MOCK_CLI_SCRIPT || '[]')
const stopHookCmd = process.env.MOCK_CLI_STOP_HOOK_CMD || ''

const argvFile = process.env.MOCK_CLI_ARGV_FILE
if (argvFile) appendFileSync(argvFile, JSON.stringify(process.argv.slice(2)) + '\n')

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
