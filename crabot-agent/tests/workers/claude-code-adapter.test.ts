import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ClaudeCodeAdapter, eventsFilePath, WorkerExitedError } from '../../src/workers/claude-code/adapter.js'
import { TmuxDriver, type TmuxSessionSpec } from '../../src/workers/tmux/driver.js'
import { CliEventChannel } from '../../src/workers/cli-events.js'
import type { IncarnationHandle, SpawnSpec, WorkerContractState } from '../../src/workers/types.js'

function detectTmux(): boolean {
  try {
    execFileSync('which', ['tmux'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const tmuxAvailable = detectTmux()

const MOCK_CLI = path.resolve(__dirname, 'fixtures/mock-cli.mjs')

interface MockStep {
  output?: string
  emitStop?: boolean
  exit?: boolean
  exitCode?: number
}

// POSIX shell 单引号转义,与 tmux/driver.ts 的私有 shQuote 同款用法(这里独立复制一份,
// 仅供测试拼装 `env VAR=... node mock-cli.mjs` 命令行使用)。
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** 拼一条 `env MOCK_CLI_SCRIPT=... MOCK_CLI_STOP_HOOK_CMD=... node mock-cli.mjs` 命令行,
 * 充当测试用的 claudeBin——mock CLI 不解析 settings.json,直接从 env 拿脚本和 stop hook 命令。 */
function claudeBinFor(script: MockStep[], stopHookCmd: string): string {
  return `env MOCK_CLI_SCRIPT=${shQuote(JSON.stringify(script))} MOCK_CLI_STOP_HOOK_CMD=${shQuote(stopHookCmd)} node ${shQuote(MOCK_CLI)}`
}

async function waitForState(
  adapter: ClaudeCodeAdapter,
  h: IncarnationHandle,
  target: WorkerContractState,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: WorkerContractState | undefined
  while (Date.now() < deadline) {
    last = await adapter.state(h)
    if (last === target) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`waitForState timeout: expected '${target}', last seen '${last}'`)
}

describe('ClaudeCodeAdapter.provision', () => {
  let ws: string

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-provision-'))
  })

  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true }).catch(() => {})
  })

  it('写出 .claude/settings.json(含 Stop/Notification hook 与 permissions)、.mcp.json、CLAUDE.md', async () => {
    const adapter = new ClaudeCodeAdapter({ dataDir: ws })
    await adapter.provision({ root: ws }, { skills: [], mcp_servers: [{ name: 'x', transport: 'stdio', command: 'node' }] })

    const settings = JSON.parse(await fs.readFile(path.join(ws, '.claude/settings.json'), 'utf-8'))
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('events-cli.jsonl')
    expect(settings.hooks.Notification[0].hooks[0].command).toContain('events-cli.jsonl')
    expect(settings.permissions.defaultMode).toBe('acceptEdits')

    const mcpJson = JSON.parse(await fs.readFile(path.join(ws, '.mcp.json'), 'utf-8'))
    expect(mcpJson.mcpServers.x.command).toBe('node')

    const claudeMd = await fs.readFile(path.join(ws, 'CLAUDE.md'), 'utf-8')
    expect(claudeMd).toContain('你是 crabot 的 worker')
  })
})

describe.skipIf(!tmuxAvailable)('ClaudeCodeAdapter (tmux + mock CLI)', () => {
  let dataDir: string
  let workspaceRoot: string
  let tmux: TmuxDriver

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-ws-'))
    tmux = new TmuxDriver()
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  async function provisionedAdapter(script: MockStep[]): Promise<{ adapter: ClaudeCodeAdapter; workerId: string }> {
    const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
    const stopHookCmd = channel.hookCommand('stop')
    const adapter = new ClaudeCodeAdapter({ dataDir, tmux, claudeBin: claudeBinFor(script, stopHookCmd) })
    // provision 建 .claude/ 目录 —— hook 写入目标目录必须先存在,否则 printf >> 静默失败。
    await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
    return { adapter, workerId: `w-${randomUUID().slice(0, 8)}` }
  }

  function makeSpec(workerId: string, prompt: string): SpawnSpec {
    return { worker_id: workerId, prompt, workspace: { root: workspaceRoot } }
  }

  it(
    '① spawn → mock 输出 → Stop hook → state 收敛 idle,readOutput 可读到该输出',
    async () => {
      const { adapter, workerId } = await provisionedAdapter([{ output: '第一段输出', emitStop: true }])
      const h = await adapter.spawn(makeSpec(workerId, '你好'))

      await waitForState(adapter, h, 'idle')

      const { chunk } = await adapter.readOutput(h, { offset: 0 })
      expect(chunk).toContain('第一段输出')
    },
    15000,
  )

  it(
    '② sendInput 续答:第二段输出追加而非覆盖,再次收敛 idle',
    async () => {
      const { adapter, workerId } = await provisionedAdapter([
        { output: '第一段输出', emitStop: true },
        { output: '第二段输出', emitStop: true },
      ])
      const h = await adapter.spawn(makeSpec(workerId, '你好'))
      await waitForState(adapter, h, 'idle')

      const before = await adapter.readOutput(h, { offset: 0 })
      expect(before.chunk).toContain('第一段输出')

      await adapter.sendInput(h, '继续')
      await waitForState(adapter, h, 'idle')

      const after = await adapter.readOutput(h, { offset: 0 })
      expect(after.chunk).toContain('第一段输出')
      expect(after.chunk).toContain('第二段输出')
    },
    15000,
  )

  it(
    '③ 进程自退(不经 Stop hook)→ tmux isAlive 判定 exited',
    async () => {
      const { adapter, workerId } = await provisionedAdapter([{ output: '收尾输出', exit: true }])
      const h = await adapter.spawn(makeSpec(workerId, '你好'))

      await waitForState(adapter, h, 'exited')

      const metaRaw = await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')
      const meta = JSON.parse(metaRaw)
      expect(meta.ended_reason).toBe('completed')
    },
    15000,
  )

  it(
    '④ kill → tmux killSession,收敛 exited(killed),再次 kill 幂等',
    async () => {
      const { adapter, workerId } = await provisionedAdapter([{ output: '还在跑' }])
      const h = await adapter.spawn(makeSpec(workerId, '你好'))

      await adapter.kill(h)
      await waitForState(adapter, h, 'exited')

      const metaRaw = await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')
      const meta = JSON.parse(metaRaw)
      expect(meta.ended_reason).toBe('killed')

      await expect(adapter.kill(h)).resolves.toBeUndefined()
      const metaAfterSecondKill = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
      expect(metaAfterSecondKill.ended_reason).toBe('killed')
    },
    15000,
  )

  it(
    '对 exited 化身 sendInput 抛 WorkerExitedError',
    async () => {
      const { adapter, workerId } = await provisionedAdapter([{ output: '收尾输出', exit: true }])
      const h = await adapter.spawn(makeSpec(workerId, '你好'))
      await waitForState(adapter, h, 'exited')

      await expect(adapter.sendInput(h, '还有件事')).rejects.toBeInstanceOf(WorkerExitedError)
    },
    15000,
  )
})

/** isAlive 可手动挂起/放行的假 TmuxDriver——不起真实 tmux 进程,专供锁纪律竞态测试控制时序。 */
class RaceTmux extends TmuxDriver {
  private pending: Array<(v: boolean) => void> = []
  get pendingCount(): number {
    return this.pending.length
  }
  async newSession(_spec: TmuxSessionSpec): Promise<void> {}
  async sendText(_name: string, _text: string): Promise<void> {}
  async sendKeys(_name: string, _keys: string[]): Promise<void> {}
  async isAlive(_name: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.pending.push(resolve)
    })
  }
  async killSession(_name: string): Promise<void> {}
  /** 放行最早挂起的一次 isAlive() 调用。 */
  releaseOne(value: boolean): void {
    const resolve = this.pending.shift()
    if (resolve) resolve(value)
  }
}

/** 转发到可替换的底层 TmuxDriver——用于"先用坏 bin 失败一次,再换成好 bin 重试"的测试场景。 */
class SwitchableTmuxDriver extends TmuxDriver {
  current: TmuxDriver
  constructor(initial: TmuxDriver) {
    super()
    this.current = initial
  }
  async available(): Promise<boolean> {
    return this.current.available()
  }
  async newSession(spec: TmuxSessionSpec): Promise<void> {
    return this.current.newSession(spec)
  }
  async sendText(name: string, text: string): Promise<void> {
    return this.current.sendText(name, text)
  }
  async sendKeys(name: string, keys: string[]): Promise<void> {
    return this.current.sendKeys(name, keys)
  }
  async isAlive(name: string): Promise<boolean> {
    return this.current.isAlive(name)
  }
  async killSession(name: string): Promise<void> {
    return this.current.killSession(name)
  }
}

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('waitUntil timeout')
}

describe('ClaudeCodeAdapter — syncState 锁纪律(P2 Task 4 评审 Important #1)', () => {
  let dataDir: string
  let workspaceRoot: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-lock-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-lock-ws-'))
    await fs.mkdir(path.join(workspaceRoot, '.claude'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  it(
    '并发 state() 与事件到达交错后,终读 idle 不回退成 running',
    async () => {
      const tmux = new RaceTmux()
      const adapter = new ClaudeCodeAdapter({ dataDir, tmux, claudeBin: 'unused-in-this-test' })
      const workerId = `w-${randomUUID().slice(0, 8)}`
      const h = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })

      // A:第一次 state() 读到 stopCount=0(还没有 stop 事件),卡在 isAlive() 上等我们放行。
      const pA = adapter.state(h)
      await waitUntil(() => tmux.pendingCount === 1)

      // 此时才有一条新鲜 stop 事件抵达。
      await fs.appendFile(eventsFilePath({ root: workspaceRoot }), '{"ts":"2026-01-01T00:00:00Z","kind":"stop","raw":null}\n')

      // B:第二次 state() 应该看到新事件、判定 idle 并落盘——不等待 A。
      const pB = adapter.state(h)

      // 给 B 一点时间尽量在旧实现下抢先完成(新实现里 B 会排在 A 持锁期间之后,不影响正确性)。
      await new Promise((r) => setTimeout(r, 300))

      // 放行 A 的 isAlive(会话仍存活)。旧实现:A 用过期快照(stopCount=0,isAlive=true)算出
      // computed='running',在锁内无条件覆盖 B 刚落的 idle。新实现:A/B 全程在锁内重读,
      // 不会用过期快照覆盖新鲜结果。
      tmux.releaseOne(true)

      await Promise.all([pA, pB])

      // 直接读盘上的终态,不经过 adapter.state()——避免再触发一次 syncState 把回退掩盖过去
      // (回退后的 running 在下一次 syncState 时,若 stopCount 仍 > baseline 会被重新判成 idle,
      // 从而掩盖了这次评审要抓的竞态)。
      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { state: WorkerContractState }
      expect(meta.state).toBe('idle')
    },
    10000,
  )
})

describe.skipIf(!tmuxAvailable)('ClaudeCodeAdapter — spawn 提交纪律(P2 Task 4 评审 Important #2)', () => {
  let dataDir: string
  let workspaceRoot: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-spawn-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-spawn-ws-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  it(
    'tmux 二进制不存在时 spawn reject 且不留 meta,改回正常 tmux 后同 worker_id 重试可成功',
    async () => {
      const badTmux = new TmuxDriver({ tmuxBin: '/nonexistent/tmux-bin-does-not-exist-crabot-test' })
      const tmux = new SwitchableTmuxDriver(badTmux)
      const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
      const stopHookCmd = channel.hookCommand('stop')
      // claudeBin 用一个存在的 sleep 命令(附加参数被 bash -c 脚本忽略),不依赖真实 claude 二进制,
      // 只用来验证 tmux 会话能正常起来、sendText 能正常注入。
      const adapter = new ClaudeCodeAdapter({ dataDir, tmux, claudeBin: `bash -c 'sleep 5'` })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `w-${randomUUID().slice(0, 8)}`
      const spec: SpawnSpec = { worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } }

      await expect(adapter.spawn(spec)).rejects.toThrow()

      // 失败(tmux newSession 拒绝)不落任何 meta——不留孤儿"running"痕迹。
      await expect(fs.access(path.join(dataDir, workerId, 'meta-1.json'))).rejects.toThrow()

      // 改回正常 tmux,同一个 worker_id 重新 spawn 应当成功(不被残留的"already spawned"卡住)。
      tmux.current = new TmuxDriver()
      const h = await adapter.spawn(spec)
      expect(h.worker_id).toBe(workerId)

      const metaRaw = await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')
      const meta = JSON.parse(metaRaw) as { state: WorkerContractState }
      expect(meta.state).toBe('running')

      await adapter.kill(h)
    },
    15000,
  )

  it(
    '首条 sendText 失败时,不放任 running——按 kill 路径落 exited(crashed),spawn 仍 reject',
    async () => {
      class NewSessionOkSendTextFailsTmux extends TmuxDriver {
        killed = false
        async newSession(spec: TmuxSessionSpec): Promise<void> {
          return super.newSession(spec)
        }
        async sendText(_name: string, _text: string): Promise<void> {
          throw new Error('simulated sendText failure')
        }
        async killSession(name: string): Promise<void> {
          this.killed = true
          return super.killSession(name)
        }
      }
      const tmux = new NewSessionOkSendTextFailsTmux()
      const adapter = new ClaudeCodeAdapter({ dataDir, tmux, claudeBin: `bash -c 'sleep 5'` })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `w-${randomUUID().slice(0, 8)}`
      const spec: SpawnSpec = { worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } }

      await expect(adapter.spawn(spec)).rejects.toThrow('simulated sendText failure')

      const metaRaw = await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')
      const meta = JSON.parse(metaRaw) as { state: WorkerContractState; ended_reason?: string }
      expect(meta.state).toBe('exited')
      expect(meta.ended_reason).toBe('crashed')
      expect(tmux.killed).toBe(true)
    },
    15000,
  )
})
