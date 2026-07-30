import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CodexWorkerAdapter, eventsFilePath, WorkerExitedError, CapabilityNotSupportedError } from '../../src/workers/codex/adapter.js'
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

/** 清理所有匹配前缀的 tmux 会话——兜底处理测试泄漏 */
async function cleanupTmuxSessions(prefix = 'crabot-w-codextest-'): Promise<void> {
  if (!tmuxAvailable) return
  try {
    const output = execFileSync('tmux', ['ls', '-F', '#{session_name}'], { encoding: 'utf-8' })
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
const FAKE_CODEX_VERSION = path.resolve(__dirname, 'fixtures/fake-codex-version.mjs')

interface MockStep {
  output?: string
  emitStop?: boolean
  exit?: boolean
  exitCode?: number
}

// POSIX shell 单引号转义,与 tmux/driver.ts 的私有 shQuote 同款用法(独立复制一份,
// 仅供测试拼装 `env VAR=... node mock-cli.mjs` 命令行使用)。
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** rollout 文件名:`rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`,与 codex 源码确认的命名格式
 * 一致(见 adapter.ts 头注释"session 发现"节)。 */
function rolloutFileNameFor(uuid: string): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  return `rollout-${ts}-${uuid}.jsonl`
}

/** 拼一条 `env MOCK_CLI_SCRIPT=... MOCK_CLI_STOP_HOOK_CMD=... [MOCK_CLI_ARGV_FILE=...]
 * [MOCK_CLI_ROLLOUT_FILE=...] node mock-cli.mjs` 命令行,充当测试用的 codexBin。 */
function codexBinFor(script: MockStep[], stopHookCmd: string, opts?: { argvFile?: string; rolloutFile?: string }): string {
  const argvEnv = opts?.argvFile ? `MOCK_CLI_ARGV_FILE=${shQuote(opts.argvFile)} ` : ''
  const rolloutEnv = opts?.rolloutFile ? `MOCK_CLI_ROLLOUT_FILE=${shQuote(opts.rolloutFile)} ` : ''
  return `env MOCK_CLI_SCRIPT=${shQuote(JSON.stringify(script))} MOCK_CLI_STOP_HOOK_CMD=${shQuote(stopHookCmd)} ${argvEnv}${rolloutEnv}node ${shQuote(MOCK_CLI)}`
}

async function waitForState(
  adapter: CodexWorkerAdapter,
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

describe('CodexWorkerAdapter.provision', () => {
  let ws: string
  let codexHomeSource: string

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-provision-'))
    codexHomeSource = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-home-src-'))
  })

  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true }).catch(() => {})
    await fs.rm(codexHomeSource, { recursive: true, force: true }).catch(() => {})
  })

  it('写出 .codex/config.toml(notify 段在 mcp_servers 表头之前)、AGENTS.md', async () => {
    const adapter = new CodexWorkerAdapter({ dataDir: ws, codexHomeSource })
    await adapter.provision({ root: ws }, { skills: [], mcp_servers: [{ name: 'x', transport: 'stdio', command: 'node' }] })

    const configToml = await fs.readFile(path.join(ws, '.codex/config.toml'), 'utf-8')
    expect(configToml).toContain('notify = ')
    expect(configToml).toContain('events-cli.jsonl')
    expect(configToml).toContain('[mcp_servers."x"]')
    expect(configToml).toContain('command = "node"')
    // TOML 根级 key(notify)必须出现在第一个 table([mcp_servers...])之前。
    expect(configToml.indexOf('notify =')).toBeLessThan(configToml.indexOf('[mcp_servers'))

    const agentsMd = await fs.readFile(path.join(ws, 'AGENTS.md'), 'utf-8')
    expect(agentsMd).toContain('你是 crabot 的 worker')
  })

  it('provision 把 codexHomeSource/auth.json 复制进 workspace 隔离出来的 .codex/auth.json', async () => {
    await fs.writeFile(path.join(codexHomeSource, 'auth.json'), '{"token":"fake"}', 'utf-8')
    const adapter = new CodexWorkerAdapter({ dataDir: ws, codexHomeSource })
    await adapter.provision({ root: ws }, { skills: [], mcp_servers: [] })

    const auth = await fs.readFile(path.join(ws, '.codex/auth.json'), 'utf-8')
    expect(auth).toBe('{"token":"fake"}')
  })

  it('provision auth.json 权限为 0o600,防止凭据泄露', async () => {
    await fs.writeFile(path.join(codexHomeSource, 'auth.json'), '{"token":"fake"}', 'utf-8')
    const adapter = new CodexWorkerAdapter({ dataDir: ws, codexHomeSource })
    await adapter.provision({ root: ws }, { skills: [], mcp_servers: [] })

    const authPath = path.join(ws, '.codex/auth.json')
    const stat = await fs.stat(authPath)
    expect((stat.mode & 0o777)).toBe(0o600)
  })

  it('provision 在 .codex/ 目录下写入 .gitignore 防止整个隔离 HOME 入库', async () => {
    const adapter = new CodexWorkerAdapter({ dataDir: ws, codexHomeSource })
    await adapter.provision({ root: ws }, { skills: [], mcp_servers: [] })

    const gitignorePath = path.join(ws, '.codex/.gitignore')
    const content = await fs.readFile(gitignorePath, 'utf-8')
    expect(content).toBe('*\n')
  })

  it('codexHomeSource 下没有 auth.json 时不阻塞 provision', async () => {
    const adapter = new CodexWorkerAdapter({ dataDir: ws, codexHomeSource })
    await expect(adapter.provision({ root: ws }, { skills: [], mcp_servers: [] })).resolves.toBeUndefined()
    await expect(fs.access(path.join(ws, '.codex/auth.json'))).rejects.toThrow()
  })

  it('provision 把 workspace 写成受信任目录(config.toml 的 [projects."<realpath>"] trust_level = "trusted",替代不存在的 --skip-git-repo-check flag)', async () => {
    const adapter = new CodexWorkerAdapter({ dataDir: ws, codexHomeSource })
    await adapter.provision({ root: ws }, { skills: [], mcp_servers: [] })

    const realRoot = await fs.realpath(ws)
    const configToml = await fs.readFile(path.join(ws, '.codex/config.toml'), 'utf-8')
    expect(configToml).toContain(`[projects."${realRoot}"]`)
    expect(configToml).toContain('trust_level = "trusted"')
    // TOML 根级 key(notify)必须出现在 [projects...] 表头之前。
    expect(configToml.indexOf('notify =')).toBeLessThan(configToml.indexOf('[projects.'))
  })
})

describe.skipIf(!tmuxAvailable)('CodexWorkerAdapter (tmux + mock CLI)', () => {
  let dataDir: string
  let workspaceRoot: string
  let tmux: TmuxDriver

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-ws-'))
    tmux = new TmuxDriver()
  })

  afterEach(async () => {
    await cleanupTmuxSessions()
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  async function provisionedAdapter(
    script: MockStep[],
    opts?: { withRollout?: boolean },
  ): Promise<{ adapter: CodexWorkerAdapter; workerId: string; rolloutUuid?: string; rolloutFile?: string }> {
    const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
    const stopHookCmd = channel.hookCommand('stop')
    const codexHome = path.join(workspaceRoot, '.codex')

    let rolloutUuid: string | undefined
    let rolloutFile: string | undefined
    if (opts?.withRollout) {
      rolloutUuid = randomUUID()
      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const datePath = path.join(String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
      rolloutFile = path.join(codexHome, 'sessions', datePath, rolloutFileNameFor(rolloutUuid))
    }

    const codexBin = codexBinFor(script, stopHookCmd, { rolloutFile })
    // 测试用小轮询上限,避免"故意不配置 rollout 文件"的用例拖慢整个套件。
    const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin, sessionDiscoveryTimeoutMs: 1500 })
    // provision 建 .codex/ 目录——hook 写入目标目录必须先存在,否则 printf >> 静默失败。
    await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
    return { adapter, workerId: `codextest-${randomUUID().slice(0, 8)}`, rolloutUuid, rolloutFile }
  }

  function makeSpec(workerId: string, prompt: string): SpawnSpec {
    return { worker_id: workerId, prompt, workspace: { root: workspaceRoot } }
  }

  it(
    '① spawn → mock 输出 → notify → state 收敛 idle,readOutput 可读到该输出',
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
    '③ 进程自退(不经 notify)→ tmux isAlive 判定 exited',
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
    'notify 已到但会话被外部 kill(不经 adapter.kill)→ 判定 exited,不永远卡在 idle(P2 review #2)',
    async () => {
      const { adapter, workerId } = await provisionedAdapter([{ output: '答完但不退出', emitStop: true }])
      const h = await adapter.spawn(makeSpec(workerId, '你好'))

      // 等 mock CLI 真的跑完 emitStop(把 stop/notify 事件写进事件文件),再从外部直接杀掉
      // tmux 会话(不经 adapter.kill,模拟进程自己崩溃/被系统杀掉)。旧实现:syncState 先看
      // notify 事件,stopCount>baseline 恒判 idle,永远走不到 isAlive 分支——这里会一直卡在
      // idle,waitForState(exited) 超时失败。
      const deadline = Date.now() + 5000
      let sawStop = false
      while (Date.now() < deadline) {
        const raw = await fs.readFile(eventsFilePath({ root: workspaceRoot }), 'utf-8').catch(() => '')
        if (raw.includes('"kind":"stop"')) {
          sawStop = true
          break
        }
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(sawStop).toBe(true)
      execFileSync('tmux', ['kill-session', '-t', `crabot-w-${workerId}-1`], { stdio: 'ignore' })

      await waitForState(adapter, h, 'exited')

      const metaRaw = await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')
      const meta = JSON.parse(metaRaw) as { state: WorkerContractState; ended_reason?: string }
      expect(meta.state).toBe('exited')
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

  it(
    'session 发现:mock CLI 落 rollout 文件时,meta.session_id 等于文件名里的 uuid,标记 session_discovery:discovered',
    async () => {
      const { adapter, workerId, rolloutUuid } = await provisionedAdapter([{ output: '第一段输出', emitStop: true }], { withRollout: true })
      const h = await adapter.spawn(makeSpec(workerId, '你好'))
      await waitForState(adapter, h, 'idle')

      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string; session_discovery?: string }
      expect(meta.session_id).toBe(rolloutUuid)
      // 发现成功应该标记为 'discovered'
      expect(meta.session_discovery).toBe('discovered')
    },
    15000,
  )

  it(
    'session 发现:没有 rollout 文件时轮询超时,退化为本地占位 uuid(仍是合法 uuid,spawn 不因此失败)',
    async () => {
      const { adapter, workerId } = await provisionedAdapter([{ output: '第一段输出', emitStop: true }])
      const h = await adapter.spawn(makeSpec(workerId, '你好'))
      await waitForState(adapter, h, 'idle')

      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string; session_discovery?: string }
      expect(meta.session_id).toMatch(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
      // 降级路径应该标记 session_discovery: 'placeholder'
      expect(meta.session_discovery).toBe('placeholder')
    },
    15000,
  )

  it(
    'session 发现:rollout 文件内容里的 session_meta.payload.session_id 优先于文件名解析出的 uuid(实测更权威,见 adapter.ts 头注释)',
    async () => {
      // 不用 provisionedAdapter 的 withRollout(mock CLI 自己落的 rollout 文件内容里没有
      // session_id 字段,只用来验证文件名兜底路径)——这里手动在发现窗口内把一个"文件名嵌
      // uuidA、内容 session_meta.payload.session_id 却是 uuidB"的 rollout 文件放进
      // sessions 目录,模拟真实 codex 落盘的权威内容,验证 adapter 采信内容而不是文件名。
      const { adapter, workerId } = await provisionedAdapter([{ output: '第一段输出', emitStop: true }])
      const uuidFromFilename = randomUUID()
      const uuidFromContent = randomUUID()

      const spawnPromise = adapter.spawn(makeSpec(workerId, '你好'))

      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const datePath = path.join(String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
      const sessionsDir = path.join(workspaceRoot, '.codex', 'sessions', datePath)
      await fs.mkdir(sessionsDir, { recursive: true })
      await fs.writeFile(
        path.join(sessionsDir, rolloutFileNameFor(uuidFromFilename)),
        JSON.stringify({ type: 'session_meta', payload: { session_id: uuidFromContent, timestamp: new Date().toISOString(), cwd: workspaceRoot } }) + '\n',
        'utf-8',
      )

      const h = await spawnPromise
      await waitForState(adapter, h, 'idle')

      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string; session_discovery?: string }
      expect(meta.session_id).toBe(uuidFromContent)
      expect(meta.session_id).not.toBe(uuidFromFilename)
      expect(meta.session_discovery).toBe('discovered')
      expect(h.session_ref).toBe(uuidFromContent)
    },
    15000,
  )

  it(
    'session 发现:轮询超时降级时输出 console.warn 日志',
    async () => {
      const { adapter, workerId } = await provisionedAdapter([{ output: '第一段输出', emitStop: true }])
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const h = await adapter.spawn(makeSpec(workerId, '你好'))
      await waitForState(adapter, h, 'idle')

      // 检查 console.warn 被调用且消息包含关键字
      expect(warnSpy).toHaveBeenCalled()
      const calls = warnSpy.mock.calls
      const warnMessage = calls[0]?.[0] ?? ''
      expect(String(warnMessage)).toContain('[codex-adapter]')
      expect(String(warnMessage)).toContain('session discovery')

      warnSpy.mockRestore()
    },
    15000,
  )

  it(
    '对同一个已 exited 的 prev 连续 resume 两次,第二次应被拒绝(先到先得,对齐 builtin,P2 review #2)',
    async () => {
      const { adapter, workerId } = await provisionedAdapter([{ output: '主线输出', exit: true }])
      const h1 = await adapter.spawn(makeSpec(workerId, '你好'))
      await waitForState(adapter, h1, 'exited')

      const meta1 = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string }

      const h2 = await adapter.resume({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '继续 1')
      expect(h2.seq).toBe(2)

      // 对同一个 prev(h1,仍是 exited 终态)再 resume 一次:nextSeq() 本身不撞号(会分配到
      // 3),但 prev 已被 h2 标记 resumed——后来者应被拒绝,不产出第二个 resume 化身(先到
      // 先得,对齐 builtin 同款 resumed 语义,P2 review #2)。
      await expect(
        adapter.resume({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '继续 2'),
      ).rejects.toThrow(/already resumed/)

      await adapter.kill(h2)
    },
    15000,
  )

  it(
    'spawn 命令行不携带 --skip-git-repo-check(该 flag 只注册在 codex exec 子解析器上,m2 实测顶层交互式 codex 没有这个 Option,传了会被 clap usage 错误拒绝),--ask-for-approval/--sandbox 取值合法',
    async () => {
      const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
      const stopHookCmd = channel.hookCommand('stop')
      const argvFile = path.join(dataDir, 'spawn-argv.jsonl')
      const codexBin = codexBinFor([{ output: '第一段输出', emitStop: true }], stopHookCmd, { argvFile })
      const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin, sessionDiscoveryTimeoutMs: 500 })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `codextest-${randomUUID().slice(0, 8)}`
      const h = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
      await waitForState(adapter, h, 'idle')

      const argv: string[] = JSON.parse((await fs.readFile(argvFile, 'utf-8')).trim().split('\n')[0])
      expect(argv).not.toContain('--skip-git-repo-check')
      const approvalIdx = argv.indexOf('--ask-for-approval')
      expect(approvalIdx).toBeGreaterThan(-1)
      expect(argv[approvalIdx + 1]).toBe('never')
      const sandboxIdx = argv.indexOf('--sandbox')
      expect(sandboxIdx).toBeGreaterThan(-1)
      expect(['read-only', 'workspace-write', 'danger-full-access']).toContain(argv[sandboxIdx + 1])

      await adapter.kill(h)
    },
    15000,
  )

  it(
    'resume 命令行不携带 --skip-git-repo-check,--ask-for-approval/--sandbox 放在 resume 子命令之前(放后面 codex 报 usage 错、exit=2,m2 实测)',
    async () => {
      const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
      const stopHookCmd = channel.hookCommand('stop')
      const argvFile = path.join(dataDir, 'resume-argv.jsonl')
      const codexBin = codexBinFor([{ output: '主线输出', exit: true }], stopHookCmd, { argvFile })
      const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin, sessionDiscoveryTimeoutMs: 500 })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `codextest-${randomUUID().slice(0, 8)}`
      const h1 = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
      await waitForState(adapter, h1, 'exited')

      const meta1 = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string }
      const h2 = await adapter.resume({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '继续')
      await waitForState(adapter, h2, 'exited')

      const lines = (await fs.readFile(argvFile, 'utf-8')).trim().split('\n')
      // 第一行是 spawn 主线的 argv,第二行才是 resume 触发的调用。
      const argv: string[] = JSON.parse(lines[1])
      expect(argv).not.toContain('--skip-git-repo-check')
      const resumeIdx = argv.indexOf('resume')
      expect(resumeIdx).toBeGreaterThan(-1)
      for (const flag of ['--ask-for-approval', '--sandbox']) {
        const idx = argv.indexOf(flag)
        expect(idx).toBeGreaterThan(-1)
        expect(idx).toBeLessThan(resumeIdx)
      }
    },
    15000,
  )
})

describe.skipIf(!tmuxAvailable)('CodexWorkerAdapter — 四轮 review PoC 回归:重启后新 adapter 实例(runtimes 为空)重连 tmux 会话(ensureRuntime)', () => {
  let dataDir: string
  let workspaceRoot: string
  let tmux: TmuxDriver

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-reattach-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-reattach-ws-'))
    tmux = new TmuxDriver()
  })

  afterEach(async () => {
    await cleanupTmuxSessions()
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  async function waitForOutputContains(adapter: CodexWorkerAdapter, h: IncarnationHandle, needle: string, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { chunk } = await adapter.readOutput(h, { offset: 0 })
      if (chunk.includes(needle)) return
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`waitForOutputContains timeout: expected output to contain '${needle}'`)
  }

  it(
    'PoC①:会话仍存活——新 adapter 实例的 sendInput/kill 应真正作用于该会话(修复前:sendInput 直接抛通用 Error "no such incarnation...resident in this process")',
    async () => {
      const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
      const stopHookCmd = channel.hookCommand('stop')
      const codexBin = codexBinFor([{ output: '第一段输出' }, { output: '第二段输出' }], stopHookCmd)

      const adapterA = new CodexWorkerAdapter({ dataDir, tmux, codexBin, sessionDiscoveryTimeoutMs: 500 })
      await adapterA.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `codextest-${randomUUID().slice(0, 8)}`
      const h = await adapterA.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })

      await waitForOutputContains(adapterA, h, '第一段输出')

      // "重启":全新 adapter 实例,同一 dataDir,内存 runtimes 为空,从未见过这个化身。
      const adapterB = new CodexWorkerAdapter({ dataDir, tmux, codexBin: 'unused-not-invoked-by-sendInput' })

      await expect(adapterB.sendInput(h, '继续')).resolves.toBeUndefined()
      await waitForOutputContains(adapterB, h, '第二段输出')

      await expect(adapterB.kill(h)).resolves.toBeUndefined()
      await waitForState(adapterB, h, 'exited')

      const metaRaw = await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')
      const meta = JSON.parse(metaRaw) as { ended_reason?: string }
      expect(meta.ended_reason).toBe('killed')
    },
    15000,
  )

  it(
    'PoC②:会话已经死掉(外部 kill,未经 adapter.kill)——新 adapter 实例的 sendInput 应抛 WorkerExitedError,不是通用 Error',
    async () => {
      const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
      const stopHookCmd = channel.hookCommand('stop')
      const codexBin = codexBinFor([{ output: '第一段输出' }], stopHookCmd)

      const adapterA = new CodexWorkerAdapter({ dataDir, tmux, codexBin, sessionDiscoveryTimeoutMs: 500 })
      await adapterA.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `codextest-${randomUUID().slice(0, 8)}`
      const h = await adapterA.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })

      await waitForOutputContains(adapterA, h, '第一段输出')

      // 绕开 adapter.kill,直接杀死 tmux 会话,模拟"agent 进程重启前已经先一步真死"。
      execFileSync('tmux', ['kill-session', '-t', `crabot-w-${workerId}-1`], { stdio: 'ignore' })

      const adapterB = new CodexWorkerAdapter({ dataDir, tmux, codexBin: 'unused-not-invoked-by-sendInput' })

      await expect(adapterB.sendInput(h, '还有件事')).rejects.toBeInstanceOf(WorkerExitedError)
      await expect(adapterB.kill(h)).resolves.toBeUndefined()
    },
    15000,
  )

  it(
    'PoC③(五轮 review):重启前有主线#1 与 resume 链 #2(两份 meta 落盘)——重启后新 adapter 实例再对#1 resume,' +
      'nextSeq 必须磁盘感知,不能只看内存(只重建了#1)算出 2 而撞上#2 的 meta/output(修复前:seq=2,meta-2.json 被覆盖,output-2.log 被复用)',
    async () => {
      const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
      const stopHookCmd = channel.hookCommand('stop')
      // 每次新起的进程(spawn/resume)都从脚本第 0 步重新跑——mock CLI 每次调用都是全新进程,
      // 不记跨调用状态。这里让脚本第一步就 exit,主线与每一次 resume 都会立刻落 exited,
      // 不需要真的等 notify。
      const codexBin = codexBinFor([{ output: '输出', exit: true }], stopHookCmd)

      const adapterA = new CodexWorkerAdapter({ dataDir, tmux, codexBin, sessionDiscoveryTimeoutMs: 500 })
      await adapterA.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `codextest-${randomUUID().slice(0, 8)}`

      // 重启前:主线 #1。
      const h1 = await adapterA.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
      await waitForState(adapterA, h1, 'exited')
      const meta1 = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string }

      // 重启前:resume 链 #2(同一进程内,落自己的 meta-2.json/output-2.log)。
      const h2 = await adapterA.resume({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '继续 1')
      expect(h2.seq).toBe(2)
      await waitForState(adapterA, h2, 'exited')
      const meta2Before = await fs.readFile(path.join(dataDir, workerId, 'meta-2.json'), 'utf-8')
      const output2Before = await fs.readFile(path.join(dataDir, workerId, 'output-2.log'), 'utf-8')

      // "重启":全新 adapter 实例,同一 dataDir,内存 runtimes 为空——只有磁盘还记得 #1、#2
      // 两份历史。对 #1 再 resume 一次:ensureRuntime 只重建出 #1 这一条 runtime(#2 从未被
      // 提及,不会被重建),旧版 nextSeq 只扫内存 runtimes(此时仅 #1)算出 2,与磁盘上的
      // #2 撞号。
      const adapterB = new CodexWorkerAdapter({ dataDir, tmux, codexBin, sessionDiscoveryTimeoutMs: 500 })
      const h3 = await adapterB.resume({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '重启后继续')
      await waitForState(adapterB, h3, 'exited')

      // 磁盘感知修复后:新化身分配到 3(不是 2),不撞上 #2 的号位。
      expect(h3.seq).toBe(3)

      // #2 的 meta/output 原封不动,没有被 resume 静默覆盖/复用。
      const meta2After = await fs.readFile(path.join(dataDir, workerId, 'meta-2.json'), 'utf-8')
      const output2After = await fs.readFile(path.join(dataDir, workerId, 'output-2.log'), 'utf-8')
      expect(meta2After).toBe(meta2Before.toString())
      expect(output2After).toBe(output2Before.toString())
    },
    15000,
  )
})

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

describe.skipIf(!tmuxAvailable)('CodexWorkerAdapter — spawn 提交纪律', () => {
  let dataDir: string
  let workspaceRoot: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-spawn-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-spawn-ws-'))
  })

  afterEach(async () => {
    await cleanupTmuxSessions()
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  it(
    'tmux 二进制不存在时 spawn reject 且不留 meta,改回正常 tmux 后同 worker_id 重试可成功',
    async () => {
      const badTmux = new TmuxDriver({ tmuxBin: '/nonexistent/tmux-bin-does-not-exist-crabot-test' })
      const tmux = new SwitchableTmuxDriver(badTmux)
      const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin: `bash -c 'sleep 5'`, sessionDiscoveryTimeoutMs: 200 })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `codextest-${randomUUID().slice(0, 8)}`
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
      const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin: `bash -c 'sleep 5'`, sessionDiscoveryTimeoutMs: 200 })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `codextest-${randomUUID().slice(0, 8)}`
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

  it(
    'spawn/resume 经 tmux 拉起子进程时,PATH 前置了 codexBin 解析出的真实目录(nvm 部署陷阱:tmux server 自身环境可能解析不到 codex 的 node,m2 实测踩到 "env: node: No such file or directory")',
    async () => {
      class RecordingTmuxDriver extends TmuxDriver {
        lastEnv?: Record<string, string>
        async newSession(spec: TmuxSessionSpec): Promise<void> {
          this.lastEnv = spec.env
          return super.newSession(spec)
        }
      }
      const toolDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-pathcheck-'))
      const codexPath = path.join(toolDir, 'codex')
      // 内容不重要——tmux new-session 本身不校验命令是否存在/能跑,只要 resolveBinDir 能
      // fs.realpath 出这个文件即可,这里放个立即退出的 sh 脚本。
      await fs.writeFile(codexPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

      const tmux = new RecordingTmuxDriver()
      const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin: codexPath, sessionDiscoveryTimeoutMs: 200 })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `codextest-${randomUUID().slice(0, 8)}`
      const spec: SpawnSpec = { worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } }

      // 会话内的假 codex 立即退出,首条 sendText 大概率落空(会话已死)——只关心 newSession
      // 拿到的 env,spawn 本身是否 reject 不是这条用例的断言点。
      await adapter.spawn(spec).catch(() => {})

      expect(tmux.lastEnv).toBeDefined()
      expect(tmux.lastEnv!.PATH).toBe(`${toolDir}:${process.env.PATH ?? ''}`)
      expect(tmux.lastEnv!.CODEX_HOME).toBe(path.join(workspaceRoot, '.codex'))

      await fs.rm(toolDir, { recursive: true, force: true }).catch(() => {})
    },
    15000,
  )
})

describe('CodexWorkerAdapter.detect', () => {
  let dataDir: string
  let home: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-detect-data-'))
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-detect-home-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  })

  function versionBin(version: string): string {
    return `env FAKE_CODEX_VERSION=${shQuote(version)} node ${shQuote(FAKE_CODEX_VERSION)}`
  }

  it('codex 二进制不存在/不可执行 → installed:false, activated:false, detail 说"没装"', async () => {
    const adapter = new CodexWorkerAdapter({
      dataDir,
      codexBin: '/nonexistent/codex-bin-does-not-exist-crabot-test',
    })
    const result = await adapter.detect()
    expect(result.installed).toBe(false)
    expect(result.activated).toBe(false)
    expect(result.detail).toContain('not found')
  })

  it(
    'codex 二进制存在但执行失败(如 shebang 解释器不可解析,nvm 部署形态的常见故障)→ detail 区分"装了但跑不起来",不是"没装"',
    async () => {
      const brokenBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-broken-bin-'))
      const brokenBin = path.join(brokenBinDir, 'codex')
      await fs.writeFile(brokenBin, '#!/nonexistent-interpreter-xyz-crabot-test\necho hi\n', { mode: 0o755 })

      const adapter = new CodexWorkerAdapter({ dataDir, codexBin: brokenBin })
      const result = await adapter.detect()
      expect(result.installed).toBe(false)
      expect(result.activated).toBe(false)
      // 区分点在消息前缀,不是"是否含 not found"——底层 shell 报错本身可能也含这个短语
      // (如 dash 对坏 shebang 报 "not found" 而不是 bash 的 "bad interpreter"),不能拿它
      // 当区分依据。
      expect(result.detail).toMatch(/^codex binary found at .+ but failed to execute/)
      expect(result.detail).toMatch(/node interpreter|unresolved/i)

      await fs.rm(brokenBinDir, { recursive: true, force: true }).catch(() => {})
    },
  )

  it('codex 已安装且 codexHomeSource 下有 auth.json → installed:true, activated:true', async () => {
    await fs.writeFile(path.join(home, 'auth.json'), '{}', 'utf-8')

    const adapter = new CodexWorkerAdapter({
      dataDir,
      codexBin: versionBin('0.45.0'),
      codexHomeSource: home,
    })
    const result = await adapter.detect()
    expect(result.installed).toBe(true)
    expect(result.activated).toBe(true)
    expect(result.detail).toContain('0.45.0')
  })

  it('codex 已安装但 codexHomeSource 下没有 auth.json/config.toml → activated:false', async () => {
    const adapter = new CodexWorkerAdapter({
      dataDir,
      codexBin: versionBin('0.45.0'),
      codexHomeSource: home, // 目录存在,但里面空的
    })
    const result = await adapter.detect()
    expect(result.installed).toBe(true)
    expect(result.activated).toBe(false)
  })

  it('codex 已安装但 codexHomeSource 目录本身不存在 → activated:false(不抛错)', async () => {
    const adapter = new CodexWorkerAdapter({
      dataDir,
      codexBin: versionBin('0.45.0'),
      codexHomeSource: path.join(home, 'does-not-exist'),
    })
    const result = await adapter.detect()
    expect(result.installed).toBe(true)
    expect(result.activated).toBe(false)
  })
})

describe('CodexWorkerAdapter — session_ref UUID 边界校验(resume)', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-session-ref-data-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('resume() 拒绝非 UUID 格式的 session_ref(含 shell 注入特征),不执行任何命令', async () => {
    const adapter = new CodexWorkerAdapter({ dataDir, codexBin: 'unused' })
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const maliciousSessionRef = 'x; touch /tmp/pwned'

    await expect(
      adapter.resume({ worker_id: workerId, seq: 1, session_ref: maliciousSessionRef }, 'payload'),
    ).rejects.toThrow(/invalid.*session_ref|UUID|session reference/i)

    await expect(fs.access('/tmp/pwned')).rejects.toThrow()
  })

  it('resume() 拒绝空白或特殊字符 session_ref', async () => {
    const adapter = new CodexWorkerAdapter({ dataDir, codexBin: 'unused' })
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const invalidRefs = ['', ' ', '$(whoami)', '`id`', '{test}', '../../../etc/passwd']

    for (const ref of invalidRefs) {
      await expect(
        adapter.resume({ worker_id: workerId, seq: 1, session_ref: ref }, 'payload'),
      ).rejects.toThrow(/invalid.*session_ref|UUID|session reference/i)
    }
  })

  it('resume() 接受有效 UUID 格式的 session_ref(至少通过前置校验)', async () => {
    const adapter = new CodexWorkerAdapter({ dataDir, codexBin: 'unused' })
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const validUuid = randomUUID()

    // 会因为"不存在该化身"抛错,但不是 session_ref 格式错误
    await expect(
      adapter.resume({ worker_id: workerId, seq: 1, session_ref: validUuid }, 'payload'),
    ).rejects.toThrow(/no such incarnation|not resident/i)
  })
})

describe('CodexWorkerAdapter.fork — capabilities.fork=false', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-fork-data-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('capabilities().fork === false', () => {
    const adapter = new CodexWorkerAdapter({ dataDir, codexBin: 'unused' })
    expect(adapter.capabilities().fork).toBe(false)
  })

  it('fork() 始终抛 CapabilityNotSupportedError,不触碰 tmux/子进程', async () => {
    const adapter = new CodexWorkerAdapter({ dataDir, codexBin: 'unused' })
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const validUuid = randomUUID()

    await expect(adapter.fork({ worker_id: workerId, seq: 1, session_ref: validUuid }, '侧问问题')).rejects.toBeInstanceOf(
      CapabilityNotSupportedError,
    )
  })
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

describe('CodexWorkerAdapter.readTrace', () => {
  let dataDir: string
  let workspaceRoot: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-trace-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-trace-ws-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  // 归一化本身(session_meta/message/function_call/function_call_output/reasoning/event_msg
  // 的字段映射)在下面 tmux+mock 的 describe 块里端到端验证(spawn 真的发现 rollout 路径后
  // 再读)。这里只验证"没有可读路径时的降级行为",不需要真实 tmux 进程。

  it('trace 文件不存在(rolloutPath 未知,占位 session_id)→ 返回空事件数组,不抛错,cursor 原样透传', async () => {
    const tmux = new NoopTmux()
    const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin: 'unused', sessionDiscoveryTimeoutMs: 50 })
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const h = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })

    const { events, nextCursor } = await adapter.readTrace(h)
    expect(events).toEqual([])
    expect(nextCursor).toEqual({ offset: 0 })

    const { events: events2, nextCursor: nextCursor2 } = await adapter.readTrace(h, { offset: 3 })
    expect(events2).toEqual([])
    expect(nextCursor2).toEqual({ offset: 3 })

    await adapter.kill(h)
  })

  it('对本进程内不常驻的 incarnation 调用 readTrace 应拒绝', async () => {
    const tmux = new NoopTmux()
    const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin: 'unused' })
    await expect(adapter.readTrace({ worker_id: 'nope', seq: 1, impl: 'codex' })).rejects.toThrow()
  })
})

describe.skipIf(!tmuxAvailable)('CodexWorkerAdapter.readTrace(已发现 rollout 路径)', () => {
  let dataDir: string
  let workspaceRoot: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-trace2-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-trace2-ws-'))
  })

  afterEach(async () => {
    await cleanupTmuxSessions('crabot-w-codextest-')
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  // 按 m2 真机实测(codex-cli 0.144.1)的 rollout 信封结构手写:每行 {type, timestamp,
  // payload},timestamp 在信封顶层(不是嵌进 payload 里)。覆盖五种顶层 type 中的
  // session_meta/event_msg/response_item/world_state/turn_context,其中后两种应被
  // readTrace 跳过(不产生事件,但仍计入 nextCursor)。
  function sampleRolloutJsonl(sessionId: string): string {
    const lines = [
      {
        type: 'session_meta',
        timestamp: '2026-07-30T01:00:00Z',
        payload: { session_id: sessionId, cli_version: '0.144.1', cwd: workspaceRoot, model_provider: 'openai', context_window: 200000, originator: 'cli' },
      },
      { type: 'turn_context', timestamp: '2026-07-30T01:00:01Z', payload: { model: 'gpt-5.5', effort: 'medium', cwd: workspaceRoot, approval_policy: 'never' } },
      {
        type: 'response_item',
        timestamp: '2026-07-30T01:00:02Z',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '你是 crabot 的 worker。' }] },
      },
      {
        type: 'response_item',
        timestamp: '2026-07-30T01:00:03Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '这个函数为什么会抛 TypeError?' }] },
      },
      {
        type: 'response_item',
        timestamp: '2026-07-30T01:00:04Z',
        payload: { type: 'function_call', name: 'shell', call_id: 'call_1', arguments: '{"command":["cat","x.ts"]}' },
      },
      { type: 'response_item', timestamp: '2026-07-30T01:00:05Z', payload: { type: 'function_call_output', call_id: 'call_1', output: '文件内容摘要' } },
      { type: 'response_item', timestamp: '2026-07-30T01:00:06Z', payload: { type: 'reasoning', summary: [{ text: '先看文件再判断' }] } },
      {
        type: 'response_item',
        timestamp: '2026-07-30T01:00:07Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '问题在于第 12 行没有判空。' }] },
      },
      {
        type: 'event_msg',
        timestamp: '2026-07-30T01:00:08Z',
        payload: { type: 'turn_complete', turn_id: 'turn_1', started_at: '2026-07-30T01:00:00Z', model_context_window: 200000 },
      },
      { type: 'world_state', timestamp: '2026-07-30T01:00:09Z', payload: { full: true, state: {} } },
      { type: 'response_item', timestamp: '2026-07-30T01:00:10Z', payload: { type: 'web_search_call', query: 'typescript typeerror' } },
    ]
    return lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot valid json{{{\n'
  }

  it('spawn 发现 rollout 路径后,readTrace 按行解析并归一化,cursor 跳过已读部分', async () => {
    const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
    const stopHookCmd = channel.hookCommand('stop')
    const codexHome = path.join(workspaceRoot, '.codex')
    const rolloutUuid = randomUUID()
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const datePath = path.join(String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
    const rolloutFile = path.join(codexHome, 'sessions', datePath, rolloutFileNameFor(rolloutUuid))

    const codexBin = codexBinFor([{ output: '第一段输出', emitStop: true }], stopHookCmd, { rolloutFile })
    const adapter = new CodexWorkerAdapter({ dataDir, tmux: new TmuxDriver(), codexBin, sessionDiscoveryTimeoutMs: 1500 })
    await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
    const workerId = `codextest-${randomUUID().slice(0, 8)}`

    const h = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
    await waitForState(adapter, h, 'idle')

    const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string }
    expect(meta.session_id).toBe(rolloutUuid)

    // mock CLI 只写了个占位 session_meta 行(供发现用),这里覆写成完整样例内容再读。
    await fs.writeFile(rolloutFile, sampleRolloutJsonl(rolloutUuid), 'utf-8')

    const { events, nextCursor } = await adapter.readTrace(h)
    // 11 行原始数据(session_meta/turn_context/developer msg/user msg/function_call/
    // function_call_output/reasoning/assistant msg/event_msg/world_state/web_search_call)
    // + 1 条坏 JSON = 12 行;turn_context/world_state/web_search_call(未识别子类型)/坏
    // JSON 四条跳过,产生 8 条事件。
    expect(events).toHaveLength(8)
    expect(events[0]).toMatchObject({ kind: 'lifecycle', role: 'system', ts: '2026-07-30T01:00:00Z' })
    expect(events[0].summary).toContain(rolloutUuid)
    expect(events[0].summary).toContain('0.144.1')
    // developer role 映射为协议允许的 'system'(NormalizedTraceEvent.role 不含 'developer')。
    expect(events[1]).toMatchObject({ kind: 'message', role: 'system', ts: '2026-07-30T01:00:02Z' })
    expect(events[1].summary).toBe('你是 crabot 的 worker。')
    expect(events[2]).toMatchObject({ kind: 'message', role: 'user' })
    expect(events[2].summary).toContain('这个函数为什么会抛 TypeError?')
    expect(events[3]).toMatchObject({ kind: 'tool_call', role: 'assistant' })
    expect(events[3].summary).toContain('shell')
    expect(events[4]).toMatchObject({ kind: 'tool_result' })
    expect(events[4].summary).toContain('文件内容摘要')
    expect(events[4].role).toBeUndefined()
    expect(events[5]).toMatchObject({ kind: 'thinking', role: 'assistant' })
    expect(events[5].summary).toContain('先看文件再判断')
    expect(events[6]).toMatchObject({ kind: 'message', role: 'assistant' })
    expect(events[6].summary).toContain('问题在于第 12 行没有判空。')
    expect(events[7]).toMatchObject({ kind: 'lifecycle', role: 'system', summary: 'turn_complete', ts: '2026-07-30T01:00:08Z' })
    expect(nextCursor.offset).toBe(12)

    const partial = await adapter.readTrace(h, { offset: 6 })
    expect(partial.events).toHaveLength(3)
    expect(partial.events[0].kind).toBe('thinking')
    expect(partial.events[1].kind).toBe('message')
    expect(partial.events[2].kind).toBe('lifecycle')
    expect(partial.nextCursor.offset).toBe(12)

    await adapter.kill(h)
  }, 15000)

  it('nextCursor 计入跳过的行(未识别 type/坏 JSON),两次 readTrace 按 nextCursor 续读不重不漏', async () => {
    const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
    const stopHookCmd = channel.hookCommand('stop')
    const codexHome = path.join(workspaceRoot, '.codex')
    const rolloutUuid = randomUUID()
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const datePath = path.join(String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
    const rolloutFile = path.join(codexHome, 'sessions', datePath, rolloutFileNameFor(rolloutUuid))

    const codexBin = codexBinFor([{ output: '第一段输出', emitStop: true }], stopHookCmd, { rolloutFile })
    const adapter = new CodexWorkerAdapter({ dataDir, tmux: new TmuxDriver(), codexBin, sessionDiscoveryTimeoutMs: 1500 })
    await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
    const workerId = `codextest-${randomUUID().slice(0, 8)}`

    const h = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
    await waitForState(adapter, h, 'idle')

    // 覆写成:1 条有效 event_msg + 1 条未识别顶层 type(跳过) + 1 条坏 JSON(跳过)。
    const initialLines = [
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'turn_context', payload: { model: 'gpt-5.5' } },
    ]
    await fs.writeFile(rolloutFile, initialLines.map((l) => JSON.stringify(l)).join('\n') + '\nnot valid json{{{\n', 'utf-8')

    const first = await adapter.readTrace(h)
    expect(first.events).toHaveLength(1)
    // 3 行原始数据(1 条有效 + 2 条被跳过),offset += events.length(1)会漏掉后面 2 行——
    // nextCursor 必须落在 3,不是 1。
    expect(first.nextCursor.offset).toBe(3)

    // 追加新一批(1 条有效 + 1 条坏 JSON),用上一次的 nextCursor 续读。
    await fs.appendFile(
      rolloutFile,
      '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\nmore bad json{{{\n',
      'utf-8',
    )

    const second = await adapter.readTrace(h, first.nextCursor)
    expect(second.events).toHaveLength(1)
    expect(second.events[0].summary).toBe('task_complete')
    expect(second.nextCursor.offset).toBe(5)

    await adapter.kill(h)
  }, 15000)

  it('半行(CLI 写入未完成,无结尾换行符)不消费,补全后续读不丢事件', async () => {
    const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
    const stopHookCmd = channel.hookCommand('stop')
    const codexHome = path.join(workspaceRoot, '.codex')
    const rolloutUuid = randomUUID()
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const datePath = path.join(String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
    const rolloutFile = path.join(codexHome, 'sessions', datePath, rolloutFileNameFor(rolloutUuid))

    const codexBin = codexBinFor([{ output: '第一段输出', emitStop: true }], stopHookCmd, { rolloutFile })
    const adapter = new CodexWorkerAdapter({ dataDir, tmux: new TmuxDriver(), codexBin, sessionDiscoveryTimeoutMs: 1500 })
    await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
    const workerId = `codextest-${randomUUID().slice(0, 8)}`

    const h = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
    await waitForState(adapter, h, 'idle')

    // trace(rollout)文件由 codex 持续追加、readTrace 轮询懒解析,读到写入中途是常态:
    // 第一行完整,第二行只写了一半(无结尾换行符)。
    const line1 = { type: 'event_msg', payload: { type: 'task_started' } }
    await fs.writeFile(rolloutFile, JSON.stringify(line1) + '\n{"type":"event_msg","payload":{"ty', 'utf-8')

    const first = await adapter.readTrace(h)
    expect(first.events).toHaveLength(1)
    // 半行不算已消费的完整行——cursor 必须停在第一行之后,不能越过半行,否则半行补全后
    // 的事件会被永久跳过。
    expect(first.nextCursor.offset).toBe(1)

    // 半行补全 + 追加新行。
    const line2 = { type: 'event_msg', payload: { type: 'task_complete' } }
    const line3 = { type: 'event_msg', payload: { type: 'shutdown_complete' } }
    await fs.writeFile(
      rolloutFile,
      JSON.stringify(line1) + '\n' + JSON.stringify(line2) + '\n' + JSON.stringify(line3) + '\n',
      'utf-8',
    )

    const second = await adapter.readTrace(h, first.nextCursor)
    expect(second.events).toHaveLength(2)
    expect(second.events[0].summary).toBe('task_complete')
    expect(second.events[1].summary).toBe('shutdown_complete')
    expect(second.nextCursor.offset).toBe(3)

    await adapter.kill(h)
  }, 15000)
})
