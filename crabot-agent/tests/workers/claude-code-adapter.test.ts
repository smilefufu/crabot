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
const FAKE_CLAUDE_VERSION = path.resolve(__dirname, 'fixtures/fake-claude-version.mjs')
const FAKE_CLAUDE_FORK = path.resolve(__dirname, 'fixtures/fake-claude-fork.mjs')

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

/** 拼一条 `env MOCK_CLI_SCRIPT=... MOCK_CLI_STOP_HOOK_CMD=... [MOCK_CLI_ARGV_FILE=...] node mock-cli.mjs`
 * 命令行,充当测试用的 claudeBin——mock CLI 不解析 settings.json,直接从 env 拿脚本和 stop
 * hook 命令。argvFile 可选:传了就让 mock-cli 把收到的 argv(如 resume 的 `--resume <id>`)
 * 记一行 JSON 进这个文件,供测试断言。 */
function claudeBinFor(script: MockStep[], stopHookCmd: string, argvFile?: string): string {
  const argvEnv = argvFile ? `MOCK_CLI_ARGV_FILE=${shQuote(argvFile)} ` : ''
  return `env MOCK_CLI_SCRIPT=${shQuote(JSON.stringify(script))} MOCK_CLI_STOP_HOOK_CMD=${shQuote(stopHookCmd)} ${argvEnv}node ${shQuote(MOCK_CLI)}`
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

describe('ClaudeCodeAdapter.detect', () => {
  let dataDir: string
  let home: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-detect-data-'))
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-detect-home-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  })

  function versionBin(version: string): string {
    return `env FAKE_CLAUDE_VERSION=${shQuote(version)} node ${shQuote(FAKE_CLAUDE_VERSION)}`
  }

  it('claude 二进制不存在/不可执行 → installed:false, activated:false', async () => {
    const adapter = new ClaudeCodeAdapter({
      dataDir,
      claudeBin: '/nonexistent/claude-bin-does-not-exist-crabot-test',
    })
    const result = await adapter.detect()
    expect(result.installed).toBe(false)
    expect(result.activated).toBe(false)
  })

  it('claude 已安装且凭据目录下有 settings.json → installed:true, activated:true', async () => {
    const claudeDir = path.join(home, '.claude')
    await fs.mkdir(claudeDir, { recursive: true })
    await fs.writeFile(path.join(claudeDir, 'settings.json'), '{}', 'utf-8')

    const adapter = new ClaudeCodeAdapter({
      dataDir,
      claudeBin: versionBin('9.9.9 (Claude Code)'),
      claudeProjectsDir: path.join(claudeDir, 'projects'),
    })
    const result = await adapter.detect()
    expect(result.installed).toBe(true)
    expect(result.activated).toBe(true)
    expect(result.detail).toContain('9.9.9')
  })

  it('claude 已安装但凭据目录下没有 settings.json/.credentials.json → activated:false', async () => {
    const claudeDir = path.join(home, '.claude')
    await fs.mkdir(claudeDir, { recursive: true }) // 目录存在,但里面空的

    const adapter = new ClaudeCodeAdapter({
      dataDir,
      claudeBin: versionBin('9.9.9 (Claude Code)'),
      claudeProjectsDir: path.join(claudeDir, 'projects'),
    })
    const result = await adapter.detect()
    expect(result.installed).toBe(true)
    expect(result.activated).toBe(false)
  })

  it('claude 已安装但 ~/.claude/ 目录本身不存在 → activated:false(不抛错)', async () => {
    const adapter = new ClaudeCodeAdapter({
      dataDir,
      claudeBin: versionBin('9.9.9 (Claude Code)'),
      claudeProjectsDir: path.join(home, '.claude-does-not-exist', 'projects'),
    })
    const result = await adapter.detect()
    expect(result.installed).toBe(true)
    expect(result.activated).toBe(false)
  })
})

describe('ClaudeCodeAdapter — session_ref UUID 边界校验', () => {
  let dataDir: string
  let workspaceRoot: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-session-ref-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-session-ref-ws-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('resume() 拒绝非 UUID 格式的 session_ref(含 shell 注入特征),不执行任何命令', async () => {
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeBin: 'unused' })
    const workerId = `w-${randomUUID().slice(0, 8)}`

    // 先 spawn 一个真实化身以供 resume 前置条件
    // 但这里其实需要一个已 exited 的化身,测试难度较高。改为直接测试 fork() 的拒绝。
    // 实际上 resume 入口需要前置化身已 exited,我们用一个简化的方式:
    // 直接测试恶意 session_ref 被拒绝。

    const maliciousSessionRef = 'x; touch /tmp/pwned'

    await expect(
      adapter.resume(
        { worker_id: workerId, seq: 1, session_ref: maliciousSessionRef },
        'payload',
      ),
    ).rejects.toThrow(/invalid.*session_ref|UUID|session reference/i)
  })

  it('fork() 拒绝非 UUID 格式的 session_ref(含 shell 注入特征),不执行子进程', async () => {
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeBin: 'unused' })
    const workerId = `w-${randomUUID().slice(0, 8)}`

    const maliciousSessionRef = 'x; touch /tmp/pwned'

    await expect(
      adapter.fork({ worker_id: workerId, seq: 1, session_ref: maliciousSessionRef }, 'payload'),
    ).rejects.toThrow(/invalid.*session_ref|UUID|session reference/i)

    // 验证没有副作用文件产生
    await expect(fs.access('/tmp/pwned')).rejects.toThrow()
  })

  it('resume() 拒绝空白或特殊字符 session_ref', async () => {
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeBin: 'unused' })
    const workerId = `w-${randomUUID().slice(0, 8)}`

    const invalidRefs = ['', ' ', '$(whoami)', '`id`', '{test}', '../../../etc/passwd']

    for (const ref of invalidRefs) {
      await expect(
        adapter.resume({ worker_id: workerId, seq: 1, session_ref: ref }, 'payload'),
      ).rejects.toThrow(/invalid.*session_ref|UUID|session reference/i)
    }
  })

  it('fork() 拒绝空白或特殊字符 session_ref', async () => {
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeBin: 'unused' })
    const workerId = `w-${randomUUID().slice(0, 8)}`

    const invalidRefs = ['', ' ', '$(whoami)', '`id`', '{test}', '../../../etc/passwd']

    for (const ref of invalidRefs) {
      await expect(
        adapter.fork({ worker_id: workerId, seq: 1, session_ref: ref }, 'payload'),
      ).rejects.toThrow(/invalid.*session_ref|UUID|session reference/i)
    }
  })

  it('resume() 接受有效 UUID 格式的 session_ref(至少通过前置校验)', async () => {
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeBin: 'unused' })
    const workerId = `w-${randomUUID().slice(0, 8)}`
    const validUuid = randomUUID()

    // 会因为"不存在该化身"抛错,但不是 session_ref 格式错误
    await expect(
      adapter.resume({ worker_id: workerId, seq: 1, session_ref: validUuid }, 'payload'),
    ).rejects.toThrow(/no such incarnation|not resident/i)
  })

  it('fork() 接受有效 UUID 格式的 session_ref(至少通过前置校验)', async () => {
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeBin: 'unused' })
    const workerId = `w-${randomUUID().slice(0, 8)}`
    const validUuid = randomUUID()

    // 会因为"不存在该化身"抛错,但不是 session_ref 格式错误
    await expect(adapter.fork({ worker_id: workerId, seq: 1, session_ref: validUuid }, 'payload')).rejects.toThrow(
      /no such incarnation|not resident/i,
    )
  })
})

describe.skipIf(!tmuxAvailable)('ClaudeCodeAdapter.resume', () => {
  let dataDir: string
  let workspaceRoot: string
  let tmux: TmuxDriver

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-resume-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-resume-ws-'))
    tmux = new TmuxDriver()
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  it(
    'resume 后新会话收到 --resume <session_ref> 参数;session_ref 不变,新化身 seq+1',
    async () => {
      const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
      const stopHookCmd = channel.hookCommand('stop')
      const argvFile = path.join(dataDir, 'argv.jsonl')
      const claudeBin = claudeBinFor([{ output: '第一轮输出', exit: true }], stopHookCmd, argvFile)
      const adapter = new ClaudeCodeAdapter({ dataDir, tmux, claudeBin })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `w-${randomUUID().slice(0, 8)}`

      const h1 = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
      await waitForState(adapter, h1, 'exited')

      const meta1 = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string }

      const h2 = await adapter.resume({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '继续,把上次的活干完')
      expect(h2.worker_id).toBe(workerId)
      expect(h2.seq).toBe(2)

      const meta2Raw = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-2.json'), 'utf-8')) as {
        session_id: string
        state: WorkerContractState
      }
      // session_ref(cc 会话 uuid)在 resume 前后不变。
      expect(meta2Raw.session_id).toBe(meta1.session_id)
      expect(meta2Raw.state).toBe('running')

      // resume 出的 mock 进程收到 wakeInput 才会跑 step0(输出+exit);等它收敛到 exited,
      // 确保子进程真的启动过、argv 记录行已经落盘,再读 argvFile——resume() 本身返回时只保证
      // tmux newSession/sendText 已提交,不保证 pane 里的 node 进程已经跑到记录 argv 那一行。
      await waitForState(adapter, h2, 'exited')

      const argvLines = (await fs.readFile(argvFile, 'utf-8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string[])
      // 最后一行是 resume 这次调用收到的 argv(第一行是 spawn 那次的 --session-id ...)。
      const resumeArgv = argvLines[argvLines.length - 1]
      expect(resumeArgv).toContain('--resume')
      expect(resumeArgv[resumeArgv.indexOf('--resume') + 1]).toBe(meta1.session_id)

      await adapter.kill(h2)
    },
    15000,
  )

  it(
    '对尚未 exited 的 prev 调用 resume 应拒绝',
    async () => {
      const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
      const stopHookCmd = channel.hookCommand('stop')
      const claudeBin = claudeBinFor([{ output: '还在跑,不退出也不 emitStop' }], stopHookCmd)
      const adapter = new ClaudeCodeAdapter({ dataDir, tmux, claudeBin })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `w-${randomUUID().slice(0, 8)}`

      const h1 = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
      const meta1 = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string }

      await expect(
        adapter.resume({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '继续'),
      ).rejects.toThrow()

      await adapter.kill(h1)
    },
    15000,
  )
})

/** 转发到内部真实 TmuxDriver 并记调用次数——用于断言 fork() 全程没碰 tmux。 */
class CountingTmux extends TmuxDriver {
  calls = { newSession: 0, sendText: 0, sendKeys: 0, killSession: 0 }
  private readonly real = new TmuxDriver()
  async newSession(spec: TmuxSessionSpec): Promise<void> {
    this.calls.newSession++
    return this.real.newSession(spec)
  }
  async sendText(name: string, text: string): Promise<void> {
    this.calls.sendText++
    return this.real.sendText(name, text)
  }
  async sendKeys(name: string, keys: string[]): Promise<void> {
    this.calls.sendKeys++
    return this.real.sendKeys(name, keys)
  }
  async isAlive(name: string): Promise<boolean> {
    return this.real.isAlive(name)
  }
  async killSession(name: string): Promise<void> {
    this.calls.killSession++
    return this.real.killSession(name)
  }
}

describe.skipIf(!tmuxAvailable)('ClaudeCodeAdapter.fork', () => {
  let dataDir: string
  let workspaceRoot: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-fork-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-fork-ws-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  function forkClaudeBin(argvFile: string, stdout: string, exitCode?: number): string {
    const exitEnv = exitCode !== undefined ? `FAKE_FORK_EXIT_CODE=${exitCode} ` : ''
    return `env FAKE_ARGV_FILE=${shQuote(argvFile)} FAKE_FORK_STDOUT=${shQuote(stdout)} ${exitEnv}node ${shQuote(FAKE_CLAUDE_FORK)}`
  }

  it(
    'fork 走无头子进程(-p ... --resume ... --fork-session ...),不触碰 tmux;exit 0 → exited(completed)',
    async () => {
      const tmux = new CountingTmux()
      const argvFile = path.join(dataDir, 'fork-argv.jsonl')
      const claudeBin = forkClaudeBin(argvFile, '侧问回复内容')
      const adapter = new ClaudeCodeAdapter({ dataDir, tmux, claudeBin })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `w-${randomUUID().slice(0, 8)}`

      // 主线:交互态,fake-claude-fork.mjs 在无 -p 的调用形态下空转不退出。
      const h1 = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
      const meta1 = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string }

      const callsBeforeFork = { ...tmux.calls }

      const h2 = await adapter.fork(
        { worker_id: workerId, seq: 1, session_ref: meta1.session_id },
        '这个函数为什么报错?',
      )
      expect(h2.worker_id).toBe(workerId)
      expect(h2.seq).toBe(2)

      // fork 全程没有调用任何 tmux 方法——不进 tmux。
      expect(tmux.calls).toEqual(callsBeforeFork)

      const state2 = await adapter.state(h2)
      expect(state2).toBe('exited')

      const meta2 = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-2.json'), 'utf-8')) as {
        state: WorkerContractState
        ended_reason?: string
      }
      expect(meta2.state).toBe('exited')
      expect(meta2.ended_reason).toBe('completed')

      const { chunk } = await adapter.readOutput(h2, { offset: 0 })
      expect(chunk).toContain('侧问回复内容')

      const argvLines = (await fs.readFile(argvFile, 'utf-8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string[])
      const forkArgv = argvLines[argvLines.length - 1]
      expect(forkArgv).toEqual([
        '-p',
        '这个函数为什么报错?',
        '--resume',
        meta1.session_id,
        '--fork-session',
        '--output-format',
        'text',
      ])

      await adapter.kill(h1)
    },
    15000,
  )

  it(
    'fork 子进程非 0 退出 → exited(crashed)',
    async () => {
      const tmux = new CountingTmux()
      const argvFile = path.join(dataDir, 'fork-argv-crash.jsonl')
      const claudeBin = forkClaudeBin(argvFile, '', 1)
      const adapter = new ClaudeCodeAdapter({ dataDir, tmux, claudeBin })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `w-${randomUUID().slice(0, 8)}`

      const h1 = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
      const meta1 = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string }

      const h2 = await adapter.fork({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '触发崩溃')

      const meta2 = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-2.json'), 'utf-8')) as {
        ended_reason?: string
      }
      expect(meta2.ended_reason).toBe('crashed')

      await adapter.kill(h1)
      void h2
    },
    15000,
  )
})

/** 全程无操作的假 TmuxDriver——readTrace 测试只需要一个"常驻 runtime"的化身,不关心 tmux 行为本身。 */
class NoopTmux extends TmuxDriver {
  async newSession(_spec: TmuxSessionSpec): Promise<void> {}
  async sendText(_name: string, _text: string): Promise<void> {}
  async sendKeys(_name: string, _keys: string[]): Promise<void> {}
  async isAlive(_name: string): Promise<boolean> {
    return true
  }
  async killSession(_name: string): Promise<void> {}
}

describe('ClaudeCodeAdapter.readTrace', () => {
  let dataDir: string
  let workspaceRoot: string
  let claudeProjectsDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-trace-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-trace-ws-'))
    claudeProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-trace-projects-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
    await fs.rm(claudeProjectsDir, { recursive: true, force: true }).catch(() => {})
  })

  function projectSlug(cwd: string): string {
    return cwd.replace(/[/.]/g, '-')
  }

  async function spawnedHandle(adapter: ClaudeCodeAdapter, workerId: string): Promise<{ h: IncarnationHandle; sessionId: string }> {
    const h = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
    const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string }
    return { h, sessionId: meta.session_id }
  }

  // 手工构造的样例 JSONL(字段名对齐 ~/.claude/projects/ 下真实会话的侦察结果:user/assistant
  // 记录含 type/uuid/parentUuid/sessionId/timestamp/message,system 含 subtype/content),
  // 内容全部原创,不摘抄真实会话。
  function sampleJsonl(sessionId: string): string {
    const lines = [
      // 0: user,纯文本消息 → kind message
      {
        parentUuid: null,
        isSidechain: false,
        type: 'user',
        message: { role: 'user', content: '这个函数为什么会抛 TypeError?' },
        uuid: '11111111-1111-1111-1111-111111111111',
        timestamp: '2026-07-29T01:00:00.000Z',
        sessionId,
      },
      // 1: assistant,tool_use content block → kind tool_call
      {
        parentUuid: '11111111-1111-1111-1111-111111111111',
        isSidechain: false,
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/tmp/x.ts' } }],
        },
        uuid: '22222222-2222-2222-2222-222222222222',
        timestamp: '2026-07-29T01:00:01.000Z',
        sessionId,
      },
      // 2: user,带 toolUseResult → kind tool_result
      {
        parentUuid: '22222222-2222-2222-2222-222222222222',
        isSidechain: false,
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '文件内容摘要' }] },
        uuid: '33333333-3333-3333-3333-333333333333',
        timestamp: '2026-07-29T01:00:02.000Z',
        toolUseResult: { success: true, content: '文件内容摘要' },
        sessionId,
      },
      // 3: assistant,纯文本回答 → kind message
      {
        parentUuid: '33333333-3333-3333-3333-333333333333',
        isSidechain: false,
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '问题在于第 12 行没有判空。' }] },
        uuid: '44444444-4444-4444-4444-444444444444',
        timestamp: '2026-07-29T01:00:03.000Z',
        sessionId,
      },
      // 4: system → kind lifecycle
      {
        parentUuid: '44444444-4444-4444-4444-444444444444',
        isSidechain: false,
        type: 'system',
        subtype: 'turn_duration',
        timestamp: '2026-07-29T01:00:04.000Z',
        uuid: '55555555-5555-5555-5555-555555555555',
        sessionId,
      },
      // 5: 其他 type → 跳过
      { type: 'queue-operation', op: 'push', sessionId },
    ]
    // 6: 坏行(非法 JSON)→ 跳过,不中断
    return lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot valid json{{{\n'
  }

  it('按 ~/.claude/projects/<slug>/<session_id>.jsonl 解析并归一化', async () => {
    const tmux = new NoopTmux()
    const adapter = new ClaudeCodeAdapter({ dataDir, tmux, claudeBin: 'unused', claudeProjectsDir })
    const workerId = `w-${randomUUID().slice(0, 8)}`
    const { h, sessionId } = await spawnedHandle(adapter, workerId)

    const slugDir = path.join(claudeProjectsDir, projectSlug(workspaceRoot))
    await fs.mkdir(slugDir, { recursive: true })
    await fs.writeFile(path.join(slugDir, `${sessionId}.jsonl`), sampleJsonl(sessionId), 'utf-8')

    const events = await adapter.readTrace(h)
    expect(events).toHaveLength(5)

    expect(events[0]).toMatchObject({ kind: 'message', role: 'user' })
    expect(events[0].summary).toContain('这个函数为什么会抛 TypeError?')

    expect(events[1]).toMatchObject({ kind: 'tool_call', role: 'assistant' })
    expect(events[1].summary).toContain('Read')

    expect(events[2]).toMatchObject({ kind: 'tool_result', role: 'user' })
    expect(events[2].summary).toContain('文件内容摘要')

    expect(events[3]).toMatchObject({ kind: 'message', role: 'assistant' })
    expect(events[3].summary).toContain('问题在于第 12 行没有判空。')

    expect(events[4]).toMatchObject({ kind: 'lifecycle', role: 'system', summary: 'turn_duration' })

    await adapter.kill(h)
  })

  it('cursor.offset 按行号跳过已读部分', async () => {
    const tmux = new NoopTmux()
    const adapter = new ClaudeCodeAdapter({ dataDir, tmux, claudeBin: 'unused', claudeProjectsDir })
    const workerId = `w-${randomUUID().slice(0, 8)}`
    const { h, sessionId } = await spawnedHandle(adapter, workerId)

    const slugDir = path.join(claudeProjectsDir, projectSlug(workspaceRoot))
    await fs.mkdir(slugDir, { recursive: true })
    await fs.writeFile(path.join(slugDir, `${sessionId}.jsonl`), sampleJsonl(sessionId), 'utf-8')

    const events = await adapter.readTrace(h, { offset: 2 })
    expect(events).toHaveLength(3)
    expect(events[0].kind).toBe('tool_result')
    expect(events[1].kind).toBe('message')
    expect(events[2].kind).toBe('lifecycle')

    await adapter.kill(h)
  })

  it('trace 文件不存在 → 返回空数组,不抛错', async () => {
    const tmux = new NoopTmux()
    const adapter = new ClaudeCodeAdapter({ dataDir, tmux, claudeBin: 'unused', claudeProjectsDir })
    const workerId = `w-${randomUUID().slice(0, 8)}`
    const { h } = await spawnedHandle(adapter, workerId)
    // 不写任何 fixture 文件。

    const events = await adapter.readTrace(h)
    expect(events).toEqual([])

    await adapter.kill(h)
  })

  it('对本进程内不常驻的 incarnation 调用 readTrace 应拒绝', async () => {
    const tmux = new NoopTmux()
    const adapter = new ClaudeCodeAdapter({ dataDir, tmux, claudeBin: 'unused', claudeProjectsDir })
    await expect(adapter.readTrace({ worker_id: 'nope', seq: 1, impl: 'claude-code' })).rejects.toThrow()
  })
})
