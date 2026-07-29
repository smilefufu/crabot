/**
 * codex adapter 接入可复用契约套件(见 contract-suite.ts 文件头注释)。真机没有 codex
 * 二进制,codexBin 换成 mock-cli.mjs(与 codex-adapter.test.ts 同款 mock)——契约套件本身
 * 不关心底层怎么产出 idle/exited,只关心 WorkerAdapter 接口的行为收敛是否符合约定。
 *
 * capabilities().fork === false 是本次 P2 Task 7 对 P1 遗留验证点的首次实测:契约套件⑦a
 * 在 caps.fork 为假时只断言 fork() reject,不要求它是特定错误类型——实测 codex adapter
 * 的 fork() 始终抛 CapabilityNotSupportedError,符合契约(细节见报告)。
 *
 * makeSpec 的同步签名与 scriptFile 中转方案,与 contract-claude-code.test.ts 同构,注释见
 * 该文件头。session 发现(spawn 轮询 rollout 文件拿真实 session_id)与本契约套件无关——
 * 不提供 MOCK_CLI_ROLLOUT_FILE,固定走"轮询超时降级为本地占位 uuid"路径,占位 uuid
 * 本身仍是合法 UUID,不影响 resume()/fork() 的 session_ref 契约测试;sessionDiscoveryTimeoutMs
 * 调小避免拖慢每个 spawn。
 *
 * 无 tmux 的环境下整个文件 skip(与 codex-adapter.test.ts 的 skipIf 守卫同一判断)。
 */
import { describe, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CodexWorkerAdapter, eventsFilePath } from '../../src/workers/codex/adapter.js'
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

/** ScriptStep → mock-cli 的 MockStep:语义与 contract-claude-code.test.ts 的同名函数一致
 * (codex adapter 的状态判定同样只看 tmux isAlive,不看退出码)。 */
function toMockSteps(script: ScriptStep[]): MockStep[] {
  return script.map((step) =>
    step.then === 'idle'
      ? { output: step.output, emitStop: true }
      : { output: step.output, exit: true, exitCode: step.then === 'exit_success' ? 0 : 1 },
  )
}

async function makeCodexFixture(): Promise<ContractFixture> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-codex-data-'))
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-codex-ws-'))
  const codexHomeSource = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-codex-home-src-'))
  const scriptFile = path.join(dataDir, 'mock-script.json')
  writeFileSync(scriptFile, '[]', 'utf-8')

  const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
  const stopHookCmd = channel.hookCommand('stop')
  const codexBin = `env MOCK_CLI_SCRIPT_FILE=${shQuote(scriptFile)} MOCK_CLI_STOP_HOOK_CMD=${shQuote(stopHookCmd)} node ${shQuote(MOCK_CLI)}`

  const tmux = new TmuxDriver()
  const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin, codexHomeSource, sessionDiscoveryTimeoutMs: 300 })
  // provision 建 .codex/ 目录——hook 写入目标目录必须先存在,否则 printf >> 静默失败。
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
    await fs.rm(codexHomeSource, { recursive: true, force: true }).catch(() => {})
  }

  return { adapter, makeSpec, cleanup }
}

if (tmuxAvailable) {
  runContractSuite('codex', makeCodexFixture)
} else {
  describe.skip('WorkerAdapter contract: codex(tmux 不可用,整个文件 skip)', () => {
    it('skipped', () => {})
  })
}
