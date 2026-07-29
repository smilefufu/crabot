#!/usr/bin/env node
// mock-cli.mjs — 测试用的假 cc/codex 进程,扮演其最小交互行为:每收到一条完整消息 stdin
// (对应 tmux sendText 注入的一次输入,不区分单行/多行)就消费脚本的下一步。脚本经
// env MOCK_CLI_SCRIPT 传入(JSON 数组,元素形如 { output？, emitStop？, exit？, exitCode？ })。
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
//
// 契约套件专用(P2 Task 7):MOCK_CLI_SCRIPT_FILE(可选,绝对路径)——契约套件的 fixture
// 里 adapter 只在构造时定死 claudeBin/codexBin 这一整条命令行,但脚本内容(ScriptStep[])
// 是每个 it() 用例调用 makeSpec() 时才知道的,晚于 adapter 构造。用一个固定路径的文件间接
// 传递脚本内容,makeSpec() 同步写文件、mock-cli 进程启动时再读,取代内联进命令行的
// MOCK_CLI_SCRIPT。两者都设置时 SCRIPT_FILE 优先;都没设置时脚本为空数组(现有用例的默认)。
//
// 契约套件的 fork() 用例还需要一次"无头一击"调用(cc adapter 的 fork 把 -p <input> 拼进
// 同一条 claudeBin 命令行,不经 tmux,直接 sh -c 执行、等子进程退出):不能沿用 stdin 驱动
// 的交互式脚本循环(exec 不会写任何东西到子进程 stdin,会一直挂起等不到的一行)。argv 里
// 出现 -p 就判定为这种一次性调用,原样把入参回显到 stdout 并立即 exit 0,不进入下面的
// stdin 循环。同理,adapter.detect() 会拿同一条 claudeBin/codexBin 命令行加一个 --version
// 单独跑一次(也是一次性调用,不写 stdin),argv 里出现 --version 同样立即打印版本号退出。
//
// bracketed paste(P2 review #2,tmux/driver.ts sendText 修复):真实 cc/codex TUI 启动时
// 会请求 bracketed paste mode(发 \x1b[?2004h),这样 tmux `paste-buffer -p` 才会把整段
// 粘贴内容用 \x1b[200~ ... \x1b[201~ 包裹,程序据此把包裹内的内容当"粘贴的一整块"处理,
// 内部换行不当提交触发,只有标记外的真实 Enter 才提交。mock 复刻同款语义(而不是简单按行
// readline),这样契约测试才能验证 sendText 对多行文本真的整段一次性到达,不会被拆成
// 逐行提交。MOCK_CLI_STDIN_LOG(可选,绝对路径)——设置后每次"提交"(收到一条完整消息)
// 都往这个文件追加一行 JSON 字符串(消息原文,含内部换行),供测试断言提交次数与内容。
// MOCK_CLI_READY_FILE(可选,绝对路径)——请求 bracketed paste 之后落一个空文件,供测试在
// 发送输入前等待"mock 已完成启动、已经请求过 bracketed paste",避免 tmux new-session 一
// 返回就立刻 sendText 时与 node 进程自身的启动耗时赛跑(这个赛跑本身是测试时序问题,不是
// sendText 机制的问题——真实 cc/codex 进程启动更慢,同样需要先起来才能谈 bracketed paste)。
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const execAsync = promisify(exec)

const pFlagIndex = process.argv.indexOf('-p')
if (pFlagIndex !== -1) {
  const forkInput = process.argv[pFlagIndex + 1] ?? ''
  process.stdout.write(`mock headless reply: ${forkInput}\n`)
  process.exit(0)
}

if (process.argv.includes('--version')) {
  process.stdout.write('mock-cli 0.0.0-test\n')
  process.exit(0)
}

const scriptFile = process.env.MOCK_CLI_SCRIPT_FILE
const script = scriptFile ? JSON.parse(readFileSync(scriptFile, 'utf-8')) : JSON.parse(process.env.MOCK_CLI_SCRIPT || '[]')
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

const stdinLogFile = process.env.MOCK_CLI_STDIN_LOG

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

// 请求 bracketed paste mode——没有这一步,tmux `paste-buffer -p` 不会包裹标记,mock 就
// 观察不到"一整块"与"逐行"的区别(等价于真实 TUI 没开这个能力时的降级行为)。
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.write('\x1b[?2004h')

const readyFile = process.env.MOCK_CLI_READY_FILE
if (readyFile) writeFileSync(readyFile, '')

let insidePaste = false
let pending = '' // 尚未解析完的原始字节(可能横跨多个 data 事件,含被截断的半个标记)
let lineBuffer = '' // 当前累积中的一条逻辑消息内容

/** str 末尾是否是 marker 的某个前缀(用于避免把跨 chunk 被截断的标记误判成普通内容)。 */
function trailingMarkerPrefixLen(str, marker) {
  const maxLen = Math.min(str.length, marker.length - 1)
  for (let len = maxLen; len > 0; len--) {
    if (str.endsWith(marker.slice(0, len))) return len
  }
  return 0
}

function submit(content) {
  if (stdinLogFile) appendFileSync(stdinLogFile, JSON.stringify(content) + '\n')
  void runStep()
}

process.stdin.on('data', (chunk) => {
  pending += chunk.toString('utf-8')

  while (pending.length > 0) {
    if (insidePaste) {
      const endIdx = pending.indexOf(PASTE_END)
      if (endIdx !== -1) {
        lineBuffer += pending.slice(0, endIdx)
        pending = pending.slice(endIdx + PASTE_END.length)
        insidePaste = false
        continue
      }
      const holdBack = trailingMarkerPrefixLen(pending, PASTE_END)
      lineBuffer += pending.slice(0, pending.length - holdBack)
      pending = pending.slice(pending.length - holdBack)
      break
    }

    const startIdx = pending.indexOf(PASTE_START)
    const nlIdx = pending.search(/[\r\n]/)
    if (startIdx !== -1 && (nlIdx === -1 || startIdx < nlIdx)) {
      lineBuffer += pending.slice(0, startIdx)
      pending = pending.slice(startIdx + PASTE_START.length)
      insidePaste = true
      continue
    }
    if (nlIdx !== -1) {
      lineBuffer += pending.slice(0, nlIdx)
      pending = pending.slice(nlIdx + 1)
      const content = lineBuffer
      lineBuffer = ''
      submit(content)
      continue
    }
    const holdBack = trailingMarkerPrefixLen(pending, PASTE_START)
    lineBuffer += pending.slice(0, pending.length - holdBack)
    pending = pending.slice(pending.length - holdBack)
    break
  }
})
