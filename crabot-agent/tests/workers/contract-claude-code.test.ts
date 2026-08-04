/**
 * claude-code adapter 接入可复用契约套件(见 contract-suite.ts 文件头注释)。真机没有 claude
 * 二进制,claudeBin 换成 mock-cli.mjs(与 claude-code-adapter.test.ts 同款 mock,细节见该
 * fixture 文件头注释)——契约套件本身不关心底层怎么产出 idle/exited,只关心
 * WorkerAdapter 接口的行为收敛是否符合约定。
 *
 * 契约套件的 makeSpec(workerId, script) 是同步签名,但 cc adapter 的 claudeBin 是构造时就
 * 定死的一整条命令行,脚本内容却要等每个 it() 调 makeSpec() 时才知道(晚于构造)——这里
 * 用一个固定路径的 scriptFile 间接传递:makeSpec() 同步写文件,mock-cli 进程启动时再读
 * (MOCK_CLI_SCRIPT_FILE,mock-cli.mjs 本次改动新增)。
 *
 * 无 tmux 的环境下整个文件 skip(与 claude-code-adapter.test.ts 的 skipIf 守卫同一判断)。
 */
import { describe, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ClaudeCodeAdapter, eventsFilePath } from '../../src/workers/claude-code/adapter.js'
import { TmuxDriver } from '../../src/workers/tmux/driver.js'
import { CliEventChannel } from '../../src/workers/cli-events.js'
import type { SpawnSpec } from '../../src/workers/types.js'
import { runContractSuite, type ScriptStep, type ContractFixture } from './contract-suite.js'

function detectTmux(): boolean {
  try {
    execFileSync('which', ['tmux'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const tmuxAvailable = detectTmux()

/** 清理某个 worker_id 名下的所有 tmux 会话(sessionName 约定 `crabot-w-<worker_id>-<seq>`)。
 * 必须按具体 worker_id 精确匹配,不能用共享前缀(如 `crabot-w-contract-`)一把梭——
 * contract-claude-code.test.ts 与 contract-codex.test.ts 的 freshWorkerId() 都来自
 * contract-suite.ts,生成的 worker_id 都是 `contract-<uuid>`,两个文件在 vitest 默认并行
 * worker 下同时跑时前缀完全一样,一把梭清理会误杀另一个文件里仍在跑的会话
 * (曾实测到 "can't find pane" 报错,根因就是这个)。 */
async function killSessionsForWorker(workerId: string): Promise<void> {
  if (!tmuxAvailable) return
  try {
    const output = execFileSync('tmux', ['ls', '-F', '#{session_name}'], { encoding: 'utf-8' })
    const prefix = `crabot-w-${workerId}-`
    const sessions = output.trim().split('\n').filter((s) => s.startsWith(prefix))
    for (const session of sessions) {
      try {
        execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' })
      } catch {
        // 会话已不存在或其他错误,忽略
      }
    }
  } catch {
    // tmux ls 失败或其他问题,忽略
  }
}

const MOCK_CLI = path.resolve(__dirname, 'fixtures/mock-cli.mjs')

interface MockStep {
  output?: string
  emitStop?: boolean
  exit?: boolean
  exitCode?: number
}

// POSIX shell 单引号转义,与 tmux/driver.ts 的私有 shQuote 同款用法(独立复制一份)。
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** ScriptStep → mock-cli 的 MockStep:'idle' 触发 stop hook 但不退出;'exit_success'/
 * 'exit_failure' 输出后分别以 0/非 0 退出——cc adapter 的三源合成状态判定只认 tmux
 * isAlive(不看退出码),两者都收敛为 exited(ended_reason 恒 completed,除非被 kill),
 * 契约套件④本身也只断言 state==='exited',不区分退出码,见 contract-suite.ts。
 *
 * 这条"恒 completed"是 **adapter 层的推断**(协议 §6.3 的可信度分级),不是 harness 编的:
 * harness 现在如实采用 adapter 上报的 ended_reason,而 cc 能上报的就只有这个推断值。 */
function toMockSteps(script: ScriptStep[]): MockStep[] {
  return script.map((step) =>
    step.then === 'idle'
      ? { output: step.output, emitStop: true }
      : { output: step.output, exit: true, exitCode: step.then === 'exit_success' ? 0 : 1 },
  )
}

async function makeClaudeCodeFixture(): Promise<ContractFixture> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-cc-data-'))
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-cc-ws-'))
  // 隔离出来的 ~/.claude/projects 等价目录,detect() 的 activated 检查读它——不依赖/不触碰
  // 开发机真实 ~/.claude/。
  const claudeProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-cc-projects-'))
  const scriptFile = path.join(dataDir, 'mock-script.json')
  writeFileSync(scriptFile, '[]', 'utf-8')

  const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
  const stopHookCmd = channel.hookCommand('stop')
  // -p 一次性调用(fork 用)、--version 一次性调用(detect 用)都不读 scriptFile,
  // mock-cli.mjs 遇到这两个 flag 直接回显/打印版本号并 exit 0。
  const claudeBin = `env MOCK_CLI_SCRIPT_FILE=${shQuote(scriptFile)} MOCK_CLI_STOP_HOOK_CMD=${shQuote(stopHookCmd)} node ${shQuote(MOCK_CLI)}`

  const tmux = new TmuxDriver()
  // claudeConfigPath:provision 会往这个"全局 ~/.claude.json"写 workspace 信任记录,
  // 契约测试一律注入临时路径,不许碰开发机上的真实文件。
  const adapter = new ClaudeCodeAdapter({
    dataDir,
    tmux,
    claudeBin,
    claudeProjectsDir,
    claudeConfigPath: path.join(dataDir, 'fake-claude.json'),
  })
  // provision 建 .claude/ 目录——hook 写入目标目录必须先存在,否则 printf >> 静默失败
  // (mock-cli 直接执行 hookCmd 本身,不解析 settings.json,但事件文件所在目录仍要求先存在)。
  await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })

  const workerIds: string[] = []

  const makeSpec = (workerId: string, script: ScriptStep[]): SpawnSpec => {
    workerIds.push(workerId)
    writeFileSync(scriptFile, JSON.stringify(toMockSteps(script)), 'utf-8')
    return { worker_id: workerId, prompt: '契约测试任务', workspace: { root: workspaceRoot } }
  }

  const cleanup = async (): Promise<void> => {
    for (const workerId of workerIds) await killSessionsForWorker(workerId)
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
    await fs.rm(claudeProjectsDir, { recursive: true, force: true }).catch(() => {})
  }

  return { adapter, makeSpec, cleanup }
}

if (tmuxAvailable) {
  runContractSuite('claude-code', makeClaudeCodeFixture)
} else {
  describe.skip('WorkerAdapter contract: claude-code(tmux 不可用,整个文件 skip)', () => {
    it('skipped', () => {})
  })
}
