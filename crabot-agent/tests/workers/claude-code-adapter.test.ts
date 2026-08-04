import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ClaudeCodeAdapter, eventsFilePath, WorkerExitedError } from '../../src/workers/claude-code/adapter.js'
import { TmuxDriver, type TmuxSessionSpec } from '../../src/workers/tmux/driver.js'
import { BRACKETED_PASTE_ENABLE } from '../../src/workers/tmux/paste-ready.js'
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
async function cleanupTmuxSessions(prefix = 'crabot-w-cctest-'): Promise<void> {
  if (!tmuxAvailable) return
  try {
    const output = execFileSync('tmux', ['ls', '-F', '#{session_name}'], { encoding: 'utf-8' })
    const sessions = output.trim().split('\n').filter((s) => s.startsWith(prefix))
    for (const session of sessions) {
      try {
        execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' })
      } catch {
        // 会话已不存在或其他错误，忽略
      }
    }
  } catch {
    // tmux ls 失败或其他问题，忽略
  }
}

/** 测试用的假 ~/.claude.json —— provision 要往这个全局文件写 workspace 信任记录,
 * 测试一律注入临时路径,不许碰开发机上的真实文件。 */
function fakeClaudeConfig(dataDir: string): string {
  return path.join(dataDir, 'fake-claude.json')
}

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

/** 假 TmuxDriver 的 newSession 替身:落一份 output 日志并写入 \e[?2004h。
 * spawn 在投递开工输入之前要等这个信号(启动期就绪握手,见 src/workers/tmux/paste-ready.ts)
 * ——不扮演"TUI 已请求 bracketed paste"的假 driver 会让每个用例白等一次握手超时。 */
async function fakeReadyNewSession(spec: TmuxSessionSpec): Promise<void> {
  await fs.writeFile(spec.outputFile, BRACKETED_PASTE_ENABLE, { flag: 'a' })
}

/** 扮演"已经就绪的 TUI"的最小 pane 命令:先请求 bracketed paste 再挂住不退。理由同上。 */
const READY_IDLE_BIN = `bash -c 'printf "\\033[?2004h"; sleep 5'`

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
  /** 假的 ~/.claude.json —— provision 会写全局信任表,测试必须注入临时路径,绝不能碰开发机真实文件。 */
  let claudeConfigPath: string

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-provision-'))
    claudeConfigPath = path.join(ws, 'fake-home', '.claude.json')
    await fs.mkdir(path.dirname(claudeConfigPath), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true }).catch(() => {})
  })

  it('写出 .claude/settings.json(含 Stop/Notification hook 与 permissions)、.mcp.json、CLAUDE.md', async () => {
    const adapter = new ClaudeCodeAdapter({ dataDir: ws, claudeConfigPath })
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

  // ~/.claude.json 的 projects[<realpath>].hasTrustDialogAccepted —— cc 交互式启动的
  // "Do you trust this folder?" 弹窗开关。不预写 → 新 workspace 每次必卡在弹窗上,
  // hook 一次都不触发(生产实测:69 分钟零事件)。
  describe('workspace 启动弹窗预授权(~/.claude.json)', () => {
    async function readConfig(): Promise<Record<string, any>> {
      return JSON.parse(await fs.readFile(claudeConfigPath, 'utf-8'))
    }

    it('文件不存在时创建,并按 workspace 的 realpath 落 hasTrustDialogAccepted', async () => {
      // 经软链到达 workspace:cc 自己写入时用的是解析过软链的路径,预写必须用 realpath,
      // 否则(实测)弹窗照旧。
      const realRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'cc-trust-real-'))
      const linkRoot = path.join(ws, 'link-to-ws')
      await fs.symlink(realRoot, linkRoot)

      const adapter = new ClaudeCodeAdapter({ dataDir: ws, claudeConfigPath })
      try {
        await adapter.provision({ root: linkRoot }, { skills: [], mcp_servers: [] })

        const config = await readConfig()
        expect(config.projects[realRoot]).toEqual({ hasTrustDialogAccepted: true, enabledMcpjsonServers: [] })
        expect(config.projects[linkRoot]).toBeUndefined()
      } finally {
        await fs.rm(realRoot, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('不覆盖同一 path 已有的其它字段,也不动其它项目条目与顶层字段', async () => {
      const realWs = await fs.realpath(ws)
      await fs.writeFile(
        claudeConfigPath,
        JSON.stringify(
          {
            numStartups: 42,
            oauthAccount: { accountUuid: 'u-1' },
            projects: {
              [realWs]: { allowedTools: ['Bash(ls:*)'], history: [{ display: '之前的对话' }] },
              '/home/someone/real-project': { hasTrustDialogAccepted: true, allowedTools: ['Read'] },
            },
          },
          null,
          2,
        ),
        'utf-8',
      )

      const adapter = new ClaudeCodeAdapter({ dataDir: ws, claudeConfigPath })
      await adapter.provision({ root: ws }, { skills: [], mcp_servers: [] })

      const config = await readConfig()
      expect(config.projects[realWs]).toEqual({
        allowedTools: ['Bash(ls:*)'],
        history: [{ display: '之前的对话' }],
        hasTrustDialogAccepted: true,
        enabledMcpjsonServers: [],
      })
      expect(config.projects['/home/someone/real-project']).toEqual({ hasTrustDialogAccepted: true, allowedTools: ['Read'] })
      expect(config.numStartups).toBe(42)
      expect(config.oauthAccount).toEqual({ accountUuid: 'u-1' })
    })

    it('并发 provision 多个 worker:每条记录都在,互不覆盖', async () => {
      const roots: string[] = []
      for (let i = 0; i < 6; i++) {
        const root = path.join(ws, `worker-ws-${i}`)
        await fs.mkdir(root, { recursive: true })
        roots.push(await fs.realpath(root))
      }
      // 每个 worker 一个独立 adapter 实例(生产上 harness 可并发 provision),
      // 共享同一份全局 ~/.claude.json —— 读-改-写必须串行化,否则后写的整份覆盖先写的。
      await Promise.all(
        roots.map((root) =>
          new ClaudeCodeAdapter({ dataDir: ws, claudeConfigPath }).provision({ root }, { skills: [], mcp_servers: [] }),
        ),
      )

      const config = await readConfig()
      for (const root of roots) {
        expect(config.projects[root], `缺少 ${root} 的预授权记录`).toEqual({ hasTrustDialogAccepted: true, enabledMcpjsonServers: [] })
      }
    })

    // provision 每次都往一个全新 workspace 写 .mcp.json,cc 于是每次都弹
    // "New MCP server found in this project: <name>" 并停下来等选择——这是 #65 堵掉信任
    // 弹窗之后紧接着的第二道阻塞,生产日志里两个卡死 worker 都倒在它上面。
    it('.mcp.json 里的 server 名预写进 enabledMcpjsonServers,消掉 "New MCP server found" 弹窗', async () => {
      const adapter = new ClaudeCodeAdapter({ dataDir: ws, claudeConfigPath })
      await adapter.provision(
        { root: ws },
        {
          skills: [],
          mcp_servers: [
            { name: 'arXivPaper', transport: 'stdio', command: 'node' },
            { name: 'chrome-devtools', transport: 'stdio', command: 'node' },
          ],
        },
      )

      const realWs = await fs.realpath(ws)
      const config = await readConfig()
      // 名字必须与我们刚写下的那份 .mcp.json 逐个对上,否则 cc 仍会为对不上的那个弹框。
      const mcpJson = JSON.parse(await fs.readFile(path.join(ws, '.mcp.json'), 'utf-8'))
      expect(config.projects[realWs].enabledMcpjsonServers).toEqual(Object.keys(mcpJson.mcpServers))
      expect(config.projects[realWs].enabledMcpjsonServers).toEqual(['arXivPaper', 'chrome-devtools'])
    })

    it('enabledMcpjsonServers 按本次 caps 整体覆盖,不与该 path 上残留的旧名字取并集', async () => {
      const realWs = await fs.realpath(ws)
      await fs.writeFile(
        claudeConfigPath,
        JSON.stringify({ projects: { [realWs]: { enabledMcpjsonServers: ['已经不在授权范围里的旧 server'] } } }, null, 2),
        'utf-8',
      )

      const adapter = new ClaudeCodeAdapter({ dataDir: ws, claudeConfigPath })
      await adapter.provision({ root: ws }, { skills: [], mcp_servers: [{ name: 'arXivPaper', transport: 'stdio', command: 'node' }] })

      const config = await readConfig()
      expect(config.projects[realWs].enabledMcpjsonServers).toEqual(['arXivPaper'])
    })

    it('已有文件是坏 JSON 时报错退出,不覆盖用户真实配置', async () => {
      await fs.writeFile(claudeConfigPath, '{ 这不是 JSON', 'utf-8')
      const adapter = new ClaudeCodeAdapter({ dataDir: ws, claudeConfigPath })

      await expect(adapter.provision({ root: ws }, { skills: [], mcp_servers: [] })).rejects.toThrow(/\.claude\.json/)
      expect(await fs.readFile(claudeConfigPath, 'utf-8')).toBe('{ 这不是 JSON')
    })
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
    await cleanupTmuxSessions()
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  async function provisionedAdapter(script: MockStep[]): Promise<{ adapter: ClaudeCodeAdapter; workerId: string }> {
    const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
    const stopHookCmd = channel.hookCommand('stop')
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin: claudeBinFor(script, stopHookCmd) })
    // provision 建 .claude/ 目录 —— hook 写入目标目录必须先存在,否则 printf >> 静默失败。
    await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
    return { adapter, workerId: `cctest-${randomUUID().slice(0, 8)}` }
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
    'stop 事件已到但会话被外部 kill(不经 adapter.kill)→ 判定 exited,不永远卡在 idle(P2 review #2)',
    async () => {
      const { adapter, workerId } = await provisionedAdapter([{ output: '答完但不退出', emitStop: true }])
      const h = await adapter.spawn(makeSpec(workerId, '你好'))

      // 等 mock CLI 真的跑完 emitStop(把 stop 事件写进事件文件),再从外部直接杀掉 tmux
      // 会话(不经 adapter.kill,模拟进程自己崩溃/被系统杀掉,adapter 对此完全不知情)。
      // 旧实现:syncState 先看 stop 事件,stopCount>baseline 恒判 idle,永远走不到 isAlive
      // 分支——这里会一直卡在 idle,waitForState(exited) 超时失败。
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
})

describe.skipIf(!tmuxAvailable)('ClaudeCodeAdapter — 四轮 review PoC 回归:重启后新 adapter 实例(runtimes 为空)重连 tmux 会话(ensureRuntime)', () => {
  let dataDir: string
  let workspaceRoot: string
  let tmux: TmuxDriver

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-reattach-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-reattach-ws-'))
    tmux = new TmuxDriver()
  })

  afterEach(async () => {
    await cleanupTmuxSessions()
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  async function waitForOutputContains(adapter: ClaudeCodeAdapter, h: IncarnationHandle, needle: string, timeoutMs = 8000): Promise<void> {
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
      // 两步都不 exit/emitStop——mock CLI 消费完第一步后挂起原地等下一条 stdin,tmux 会话
      // 因此持续存活,直到显式 kill,给"重连一个仍存活的会话"提供稳定的时间窗口。
      const claudeBin = claudeBinFor([{ output: '第一段输出' }, { output: '第二段输出' }], stopHookCmd)

      const adapterA = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin })
      await adapterA.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `cctest-${randomUUID().slice(0, 8)}`
      const h = await adapterA.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })

      await waitForOutputContains(adapterA, h, '第一段输出')

      // "重启":全新 adapter 实例,同一 dataDir,内存 runtimes 为空,从未见过这个化身。
      const adapterB = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin: 'unused-not-invoked-by-sendInput' })

      // 修复前这里直接抛通用 Error;修复后 ensureRuntime 从落盘 meta(含本轮新增的
      // workspace_root)+ 真实 tmux isAlive 探测重建出可操作的 runtime。
      await expect(adapterB.sendInput(h, '继续')).resolves.toBeUndefined()

      // sendInput 真正送达存活会话:mock CLI 消费下一步,写出第二段输出。
      await waitForOutputContains(adapterB, h, '第二段输出')

      // kill 同样应该真正终止这个会话,不是抛错。
      await expect(adapterB.kill(h)).resolves.toBeUndefined()
      await waitForState(adapterB, h, 'exited')

      const metaRaw = await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')
      const meta = JSON.parse(metaRaw) as { ended_reason?: string }
      expect(meta.ended_reason).toBe('killed')
    },
    15000,
  )

  it(
    'PoC②:会话已经死掉(外部 kill,未经 adapter.kill)——新 adapter 实例的 sendInput 应抛 WorkerExitedError,不是通用 Error(harness 靠这个类型判断才会转透明接续)',
    async () => {
      const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
      const stopHookCmd = channel.hookCommand('stop')
      const claudeBin = claudeBinFor([{ output: '第一段输出' }], stopHookCmd)

      const adapterA = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin })
      await adapterA.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `cctest-${randomUUID().slice(0, 8)}`
      const h = await adapterA.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })

      await waitForOutputContains(adapterA, h, '第一段输出')

      // 绕开 adapter.kill,直接杀死 tmux 会话——模拟"agent 进程重启前,这个 worker 的 tmux
      // 会话已经先一步真死(崩溃/被系统 OOM kill 等)",没有任何机制把这件事记进 meta。
      execFileSync('tmux', ['kill-session', '-t', `crabot-w-${workerId}-1`], { stdio: 'ignore' })

      // "重启":全新 adapter 实例,同一 dataDir,内存 runtimes 为空。
      const adapterB = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin: 'unused-not-invoked-by-sendInput' })

      // 修复前:sendInput 直接抛通用 Error("no such incarnation...resident in this
      // process")——harness 只对 WorkerExitedError 转透明接续,通用 Error 会原样穿透砸给
      // 调用方,消息永久卡在队首。修复后:ensureRuntime 重建出 runtime(meta 还在),真实
      // tmux isAlive 探测发现会话已死 → runtime.state 直接是 'exited' → 既有的 syncState
      // 快路径产出 WorkerExitedError。
      await expect(adapterB.sendInput(h, '还有件事')).rejects.toBeInstanceOf(WorkerExitedError)

      // kill 对已经不存在的会话应幂等成功,不抛错。
      await expect(adapterB.kill(h)).resolves.toBeUndefined()
    },
    15000,
  )

  it(
    'PoC③(五轮 review):重启前有主线#1 + fork侧问#2(两份 meta 落盘)——重启后新 adapter 实例对#1 resume,nextSeq 必须磁盘感知,' +
      '不能只看内存(只重建了#1)算出 2 而撞上#2 的 meta/output(修复前:seq=2,meta-2.json 被覆盖,output-2.log 被复用)',
    async () => {
      const argvFile = path.join(dataDir, 'poc3-fork-argv.jsonl')
      const claudeBin = `env FAKE_ARGV_FILE=${shQuote(argvFile)} FAKE_FORK_STDOUT=${shQuote('侧问回复内容')} node ${shQuote(FAKE_CLAUDE_FORK)}`

      const adapterA = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin })
      await adapterA.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `cctest-${randomUUID().slice(0, 8)}`

      // 重启前:主线 #1(交互态,fake-claude-fork.mjs 无 -p 时空转不退出)。
      const h1 = await adapterA.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
      const meta1 = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string }

      // 重启前:fork 侧问 #2(无头一击,落自己的 meta-2.json/output-2.log)。
      const h2 = await adapterA.fork({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '侧问一下')
      expect(h2.seq).toBe(2)
      await waitForState(adapterA, h2, 'exited')
      const meta2Before = await fs.readFile(path.join(dataDir, workerId, 'meta-2.json'), 'utf-8')
      const output2Before = await fs.readFile(path.join(dataDir, workerId, 'output-2.log'), 'utf-8')
      expect(output2Before).toContain('侧问回复内容')

      // 重启前:主线 #1 落 exited,满足 resume 前置条件。
      await adapterA.kill(h1)

      // "重启":全新 adapter 实例,同一 dataDir,内存 runtimes 为空——只有磁盘还记得 #1、#2
      // 两份历史。resume(#1) 会先经 ensureRuntime 只重建出 #1 这一条 runtime(#2 从未被
      // 提及,不会被重建),旧版 nextSeq 只扫内存 runtimes(此时仅 #1)算出 2,与磁盘上的
      // #2 撞号。
      const adapterB = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin })
      const h3 = await adapterB.resume({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '继续')

      // 磁盘感知修复后:新化身分配到 3(不是 2),不撞上 #2 的号位。
      expect(h3.seq).toBe(3)

      // #2 的 meta/output 原封不动,没有被 resume 静默覆盖/复用。
      const meta2After = await fs.readFile(path.join(dataDir, workerId, 'meta-2.json'), 'utf-8')
      const output2After = await fs.readFile(path.join(dataDir, workerId, 'output-2.log'), 'utf-8')
      expect(meta2After).toBe(meta2Before.toString())
      expect(output2After).toBe(output2Before.toString())

      await adapterB.kill(h3)
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
  async newSession(spec: TmuxSessionSpec): Promise<void> {
    await fakeReadyNewSession(spec)
  }
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
      const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin: 'unused-in-this-test' })
      const workerId = `cctest-${randomUUID().slice(0, 8)}`
      const h = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })

      // A:第一次 state() 进锁,isAlive 检查提到最前(P2 review #2),无论 stopCount 是否已有
      // 新事件都要先卡在 isAlive() 上等我们放行。
      const pA = adapter.state(h)
      await waitUntil(() => tmux.pendingCount === 1)

      // 此时才有一条新鲜 stop 事件抵达。
      await fs.appendFile(eventsFilePath({ root: workspaceRoot }), '{"ts":"2026-01-01T00:00:00Z","kind":"stop","raw":null}\n')

      // B:第二次 state() 进同一把互斥锁排队——必须等 A 的读+判定+提交整体在锁内收尾之后才能
      // 开始(锁纪律早已是这样;这里只是确认 isAlive 检查顺序调整后仍然成立)。
      const pB = adapter.state(h)

      // 放行 A 的 isAlive(会话仍存活)→ A 判定 running(stopCount=0 未越 baseline),
      // 与当前状态相同,无需落盘,锁释放。
      tmux.releaseOne(true)

      // B 才真正开始执行:读到新的 stop 事件(stopCount=1),同样先卡在 isAlive() 上。
      await waitUntil(() => tmux.pendingCount === 1)
      tmux.releaseOne(true)

      await Promise.all([pA, pB])

      // 直接读盘上的终态,不经过 adapter.state()——避免再触发一次 syncState 把回退掩盖过去。
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
    await cleanupTmuxSessions()
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
      const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin: READY_IDLE_BIN })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `cctest-${randomUUID().slice(0, 8)}`
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
      const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin: READY_IDLE_BIN })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `cctest-${randomUUID().slice(0, 8)}`
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
      claudeConfigPath: fakeClaudeConfig(dataDir),
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
      claudeConfigPath: fakeClaudeConfig(dataDir),
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
      claudeConfigPath: fakeClaudeConfig(dataDir),
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
      claudeConfigPath: fakeClaudeConfig(dataDir),
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
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), claudeBin: 'unused' })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`

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
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), claudeBin: 'unused' })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`

    const maliciousSessionRef = 'x; touch /tmp/pwned'

    await expect(
      adapter.fork({ worker_id: workerId, seq: 1, session_ref: maliciousSessionRef }, 'payload'),
    ).rejects.toThrow(/invalid.*session_ref|UUID|session reference/i)

    // 验证没有副作用文件产生
    await expect(fs.access('/tmp/pwned')).rejects.toThrow()
  })

  it('resume() 拒绝空白或特殊字符 session_ref', async () => {
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), claudeBin: 'unused' })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`

    const invalidRefs = ['', ' ', '$(whoami)', '`id`', '{test}', '../../../etc/passwd']

    for (const ref of invalidRefs) {
      await expect(
        adapter.resume({ worker_id: workerId, seq: 1, session_ref: ref }, 'payload'),
      ).rejects.toThrow(/invalid.*session_ref|UUID|session reference/i)
    }
  })

  it('fork() 拒绝空白或特殊字符 session_ref', async () => {
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), claudeBin: 'unused' })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`

    const invalidRefs = ['', ' ', '$(whoami)', '`id`', '{test}', '../../../etc/passwd']

    for (const ref of invalidRefs) {
      await expect(
        adapter.fork({ worker_id: workerId, seq: 1, session_ref: ref }, 'payload'),
      ).rejects.toThrow(/invalid.*session_ref|UUID|session reference/i)
    }
  })

  it('resume() 接受有效 UUID 格式的 session_ref(至少通过前置校验)', async () => {
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), claudeBin: 'unused' })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`
    const validUuid = randomUUID()

    // 会因为"不存在该化身"抛错,但不是 session_ref 格式错误
    await expect(
      adapter.resume({ worker_id: workerId, seq: 1, session_ref: validUuid }, 'payload'),
    ).rejects.toThrow(/no such incarnation|not resident/i)
  })

  it('fork() 接受有效 UUID 格式的 session_ref(至少通过前置校验)', async () => {
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), claudeBin: 'unused' })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`
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
    await cleanupTmuxSessions()
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
      const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `cctest-${randomUUID().slice(0, 8)}`

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
      const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `cctest-${randomUUID().slice(0, 8)}`

      const h1 = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
      const meta1 = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string }

      await expect(
        adapter.resume({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '继续'),
      ).rejects.toThrow()

      await adapter.kill(h1)
    },
    15000,
  )

  it(
    '对同一个已 exited 的 prev 连续 resume 两次,第二次应被拒绝(先到先得,对齐 builtin,P2 review #2)',
    async () => {
      const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
      const stopHookCmd = channel.hookCommand('stop')
      const claudeBin = claudeBinFor([{ output: '第一轮输出', exit: true }], stopHookCmd)
      const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `cctest-${randomUUID().slice(0, 8)}`

      const h1 = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
      await waitForState(adapter, h1, 'exited')

      const meta1 = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string }

      const h2 = await adapter.resume({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '继续 1')
      expect(h2.seq).toBe(2)

      // 对同一个 prev(h1)再 resume 一次:nextSeq() 本身不撞号,但 prev 已被 h2 标记
      // resumed——后来者应被拒绝,不产出第二个 resume 化身(先到先得,对齐 builtin 同款
      // resumed 语义)。
      await expect(
        adapter.resume({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '继续 2'),
      ).rejects.toThrow(/already resumed/)

      await adapter.kill(h2)
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
    await cleanupTmuxSessions()
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
      const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `cctest-${randomUUID().slice(0, 8)}`

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
      const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `cctest-${randomUUID().slice(0, 8)}`

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

  it(
    '连续两次 fork 同一个 prev,seq 用 nextSeq() 递增分配,不撞号(P2 review #1)',
    async () => {
      const tmux = new CountingTmux()
      const argvFile = path.join(dataDir, 'fork-argv-seq.jsonl')
      const claudeBin = forkClaudeBin(argvFile, '侧问回复')
      const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `cctest-${randomUUID().slice(0, 8)}`

      const h1 = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
      const meta1 = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string }

      const h2 = await adapter.fork({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '第一次侧问')
      expect(h2.seq).toBe(2)

      // 对同一个 prev(h1)再 fork 一次:fork 化身常驻不删,旧实现用固定公式 prev.seq+1 算出
      // seq=2,与 h2 撞号,抛"already exists"。新实现用 nextSeq()(该 worker 现存所有化身
      // max seq + 1)分配到 3。
      const h3 = await adapter.fork({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '第二次侧问')
      expect(h3.seq).toBe(3)

      const meta3 = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-3.json'), 'utf-8')) as { state: WorkerContractState }
      expect(meta3.state).toBe('exited')

      await adapter.kill(h1)
    },
    15000,
  )

  it(
    'fork 之后 resume 主线,seq 用 nextSeq() 分配,不与 fork 化身撞号(P2 review #1)',
    async () => {
      const tmux = new CountingTmux()
      const argvFile = path.join(dataDir, 'fork-then-resume-argv.jsonl')
      const claudeBin = forkClaudeBin(argvFile, '侧问回复')
      const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `cctest-${randomUUID().slice(0, 8)}`

      const h1 = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
      const meta1 = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string }

      const h2 = await adapter.fork({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '侧问')
      expect(h2.seq).toBe(2)

      // 主线还在跑,先 kill 让它落 exited,满足 resume 的前置条件。
      await adapter.kill(h1)

      // resume 主线:fork 化身 h2(seq=2)常驻不删,旧实现用固定公式 prev.seq+1=2 会与它撞号,
      // 抛"already exists"。新实现用 nextSeq() 分配到 3。
      const h3 = await adapter.resume({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '继续')
      expect(h3.seq).toBe(3)

      await adapter.kill(h3)
    },
    15000,
  )
})

/** 全程无操作的假 TmuxDriver——readTrace 测试只需要一个"常驻 runtime"的化身,不关心 tmux 行为本身。 */
class NoopTmux extends TmuxDriver {
  async newSession(spec: TmuxSessionSpec): Promise<void> {
    await fakeReadyNewSession(spec)
  }
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
    await cleanupTmuxSessions()
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
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin: 'unused', claudeProjectsDir })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`
    const { h, sessionId } = await spawnedHandle(adapter, workerId)

    const slugDir = path.join(claudeProjectsDir, projectSlug(workspaceRoot))
    await fs.mkdir(slugDir, { recursive: true })
    await fs.writeFile(path.join(slugDir, `${sessionId}.jsonl`), sampleJsonl(sessionId), 'utf-8')

    const { events, nextCursor } = await adapter.readTrace(h)
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

    // 原始行数是 7(5 条产生事件 + 1 条 queue-operation 跳过 + 1 条坏 JSON 跳过),
    // nextCursor 必须计入被跳过的行,不能等于 events.length。
    expect(nextCursor.offset).toBe(7)

    await adapter.kill(h)
  })

  it('cursor.offset 按行号跳过已读部分', async () => {
    const tmux = new NoopTmux()
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin: 'unused', claudeProjectsDir })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`
    const { h, sessionId } = await spawnedHandle(adapter, workerId)

    const slugDir = path.join(claudeProjectsDir, projectSlug(workspaceRoot))
    await fs.mkdir(slugDir, { recursive: true })
    await fs.writeFile(path.join(slugDir, `${sessionId}.jsonl`), sampleJsonl(sessionId), 'utf-8')

    const { events, nextCursor } = await adapter.readTrace(h, { offset: 2 })
    expect(events).toHaveLength(3)
    expect(events[0].kind).toBe('tool_result')
    expect(events[1].kind).toBe('message')
    expect(events[2].kind).toBe('lifecycle')
    expect(nextCursor.offset).toBe(7)

    await adapter.kill(h)
  })

  it('nextCursor 计入跳过的坏行/未知类型行,两次 readTrace 按 nextCursor 续读不重不漏', async () => {
    const tmux = new NoopTmux()
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin: 'unused', claudeProjectsDir })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`
    const { h, sessionId } = await spawnedHandle(adapter, workerId)

    const slugDir = path.join(claudeProjectsDir, projectSlug(workspaceRoot))
    await fs.mkdir(slugDir, { recursive: true })
    const filePath = path.join(slugDir, `${sessionId}.jsonl`)
    await fs.writeFile(filePath, sampleJsonl(sessionId), 'utf-8')

    const first = await adapter.readTrace(h)
    expect(first.events).toHaveLength(5)
    // 若调用方错误地用 offset += events.length(5)推进游标,会漏掉被跳过的 queue-operation
    // 行和坏 JSON 行(原始 7 行)——nextCursor 必须落在 7,不是 5。
    expect(first.nextCursor.offset).toBe(7)

    // 追加新一批(1 条有效消息 + 1 条坏 JSON),用上一次的 nextCursor 续读。
    const newLine = {
      parentUuid: '55555555-5555-5555-5555-555555555555',
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: '还有一个问题' },
      uuid: '66666666-6666-6666-6666-666666666666',
      timestamp: '2026-07-29T01:00:05.000Z',
      sessionId,
    }
    await fs.appendFile(filePath, '\n' + JSON.stringify(newLine) + '\nanother bad line{{{\n', 'utf-8')

    const second = await adapter.readTrace(h, first.nextCursor)
    expect(second.events).toHaveLength(1)
    expect(second.events[0].summary).toContain('还有一个问题')
    // 没有重复读到第一批的任何事件。
    expect(second.events.map((e) => e.summary)).not.toContain('这个函数为什么会抛 TypeError?')
    expect(second.nextCursor.offset).toBe(9)

    await adapter.kill(h)
  })

  it('半行(CLI 写入未完成,无结尾换行符)不消费,补全后续读不丢事件', async () => {
    const tmux = new NoopTmux()
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin: 'unused', claudeProjectsDir })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`
    const { h, sessionId } = await spawnedHandle(adapter, workerId)

    const slugDir = path.join(claudeProjectsDir, projectSlug(workspaceRoot))
    await fs.mkdir(slugDir, { recursive: true })
    const filePath = path.join(slugDir, `${sessionId}.jsonl`)

    const line1 = {
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: '第一条' },
      uuid: '11111111-1111-1111-1111-111111111111',
      timestamp: '2026-07-29T01:00:00.000Z',
      sessionId,
    }
    // trace 文件由 CLI 持续追加、readTrace 轮询懒解析,读到写入中途是常态:第一行完整,
    // 第二行只写了一半(无结尾换行符)。
    await fs.writeFile(filePath, JSON.stringify(line1) + '\n{"type":"user","message":{"rol', 'utf-8')

    const first = await adapter.readTrace(h)
    expect(first.events).toHaveLength(1)
    expect(first.events[0].summary).toContain('第一条')
    // 半行不算已消费的完整行——cursor 必须停在第一行之后,不能越过半行,否则半行补全后
    // 的事件会被永久跳过。
    expect(first.nextCursor.offset).toBe(1)

    // 半行补全 + 追加新行。
    const line2 = {
      parentUuid: '11111111-1111-1111-1111-111111111111',
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: '第二条(补全)' },
      uuid: '22222222-2222-2222-2222-222222222222',
      timestamp: '2026-07-29T01:00:01.000Z',
      sessionId,
    }
    const line3 = {
      parentUuid: '22222222-2222-2222-2222-222222222222',
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: '第三条' },
      uuid: '33333333-3333-3333-3333-333333333333',
      timestamp: '2026-07-29T01:00:02.000Z',
      sessionId,
    }
    await fs.writeFile(
      filePath,
      JSON.stringify(line1) + '\n' + JSON.stringify(line2) + '\n' + JSON.stringify(line3) + '\n',
      'utf-8',
    )

    const second = await adapter.readTrace(h, first.nextCursor)
    expect(second.events).toHaveLength(2)
    expect(second.events[0].summary).toContain('第二条(补全)')
    expect(second.events[1].summary).toContain('第三条')
    expect(second.nextCursor.offset).toBe(3)

    await adapter.kill(h)
  })

  it('trace 文件不存在 → 返回空事件数组,不抛错,cursor 原样透传', async () => {
    const tmux = new NoopTmux()
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin: 'unused', claudeProjectsDir })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`
    const { h } = await spawnedHandle(adapter, workerId)
    // 不写任何 fixture 文件。

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
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeConfigPath: fakeClaudeConfig(dataDir), tmux, claudeBin: 'unused', claudeProjectsDir })
    await expect(adapter.readTrace({ worker_id: 'nope', seq: 1, impl: 'claude-code' })).rejects.toThrow()
  })
})

/**
 * 协议 §6.2.3「harness 以文件监视接收」的接线回归:hook 老实往 events-cli.jsonl 写,
 * 但在接上 CliEventChannel.watch() 之前没人读——cc worker 连"这一轮干完了"的 push 都
 * 没有(syncState 是纯 pull,生产侧无任何定时器轮询),派得出去收不回来。
 *
 * 这些用例的关键约束:**全程不调用 adapter.state()/sendInput()** —— 一旦调了就退回
 * pull 路径,测不出接线是否存在。
 */
describe('ClaudeCodeAdapter — CLI hook 事件文件监视(被动 push)', () => {
  let dataDir: string
  let workspaceRoot: string
  let claudeProjectsDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-watch-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-watch-ws-'))
    claudeProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-watch-proj-'))
    await fs.mkdir(path.join(workspaceRoot, '.claude'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
    await fs.rm(claudeProjectsDir, { recursive: true, force: true }).catch(() => {})
  })

  async function appendStopEvent(): Promise<void> {
    await fs.appendFile(
      eventsFilePath({ root: workspaceRoot }),
      JSON.stringify({ ts: new Date().toISOString(), kind: 'stop', raw: null }) + '\n',
      'utf-8',
    )
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('waitFor timeout')
  }

  it('spawn 之后 hook 往事件文件追加 stop → 无人调用 state()/sendInput() 也能推出 idle 状态回调', async () => {
    const seen: Array<{ seq: number; state: WorkerContractState }> = []
    const tmux = new NoopTmux()
    const adapter = new ClaudeCodeAdapter({
      dataDir,
      claudeConfigPath: fakeClaudeConfig(dataDir),
      tmux,
      claudeBin: 'unused',
      claudeProjectsDir,
      onStateChange: (h, state) => {
        seen.push({ seq: h.seq, state })
      },
    })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`
    const h = await adapter.spawn({ worker_id: workerId, prompt: '干活', workspace: { root: workspaceRoot } })

    await appendStopEvent()
    await waitFor(() => seen.some((e) => e.state === 'idle'))

    expect(seen.filter((e) => e.state === 'idle')).toHaveLength(1)
    expect(seen[seen.length - 1]).toEqual({ seq: h.seq, state: 'idle' })

    await adapter.kill(h)
  })

  it('化身落终态后 watcher 停止:kill 之后再追加 stop 事件不再产生任何状态回调', async () => {
    const seen: WorkerContractState[] = []
    const tmux = new NoopTmux()
    const adapter = new ClaudeCodeAdapter({
      dataDir,
      claudeConfigPath: fakeClaudeConfig(dataDir),
      tmux,
      claudeBin: 'unused',
      claudeProjectsDir,
      onStateChange: (_h, state) => {
        seen.push(state)
      },
    })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`
    const h = await adapter.spawn({ worker_id: workerId, prompt: '干活', workspace: { root: workspaceRoot } })

    await adapter.kill(h)
    expect(seen).toEqual(['exited'])

    await appendStopEvent()
    await new Promise((r) => setTimeout(r, 500))
    expect(seen).toEqual(['exited'])
  })

  it('spawn 时 workspace 里已有历史 stop 事件(同 workspace 的上一化身留下的)不会被误当作本化身刚完成', async () => {
    // stopBaseline 必须以"建立 runtime 那一刻文件里已有的 stop 数"起算——否则 watcher 的
    // 首次 pump 读到历史行就会立刻推一个假的 idle 出去(resume 复用同一 workspace 时必然发生)。
    await appendStopEvent()
    await appendStopEvent()

    const seen: WorkerContractState[] = []
    const tmux = new NoopTmux()
    const adapter = new ClaudeCodeAdapter({
      dataDir,
      claudeConfigPath: fakeClaudeConfig(dataDir),
      tmux,
      claudeBin: 'unused',
      claudeProjectsDir,
      onStateChange: (_h, state) => {
        seen.push(state)
      },
    })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`
    const h = await adapter.spawn({ worker_id: workerId, prompt: '干活', workspace: { root: workspaceRoot } })

    await new Promise((r) => setTimeout(r, 500))
    expect(seen).toEqual([])

    // 本化身自己产生的那一条才算数。
    await appendStopEvent()
    await waitFor(() => seen.includes('idle'))
    expect(seen).toEqual(['idle'])

    await adapter.kill(h)
  })

  // ---- onStateChange 上报的 report.endReason:cc 上报的是**推断**,不是确证 ----

  it('tmux 会话消失(非本进程 kill)→ 回调 report.endReason 上报 completed;这是推断,不表示任务真的成功', async () => {
    // ⚠️ 这条断言钉住的是 cc adapter 的**能力天花板**,不是"任务成功"这件事的证据。
    //
    // cc 的退出判定唯一依据是 `tmux.isAlive`(adapter 的三源合成状态判定不看退出码):
    // "会话没了且 runtime.killed 没置位" ⇒ 记 'completed'。cc 没有任何可得的任务成败
    // 信号——退出码没捕获(tmux 未设 remain-on-exit)、hook payload 被 CliEventChannel
    // 主动丢弃、也没有 builtin 那样的 finish_task 结构化上报。所以一个失败退出的 cc
    // worker 在这里同样会被记成 'completed'(协议 §6.3 已写明这条可信度分级)。
    //
    // 本次修复保证的是"harness 不再丢弃 adapter 已知的真值",不保证"所有实现都知道
    // 真值"。给 cc/codex 补终态上报是另一个设计任务,不在本次范围。
    const seen: Array<{ state: WorkerContractState; endReason?: string }> = []
    class DeadTmux extends NoopTmux {
      async isAlive(_name: string): Promise<boolean> {
        return false
      }
    }
    const adapter = new ClaudeCodeAdapter({
      dataDir,
      claudeConfigPath: fakeClaudeConfig(dataDir),
      tmux: new NoopTmux(),
      claudeBin: 'unused',
      claudeProjectsDir,
      onStateChange: (_h, state, report) => {
        seen.push({ state, endReason: report?.endReason })
      },
    })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`
    const h = await adapter.spawn({ worker_id: workerId, prompt: '干活', workspace: { root: workspaceRoot } })
    expect(seen).toEqual([])

    // 会话凭空消失(worker 自己退了 / 崩了 / 被外部杀了——adapter 分辨不出是哪一种)。
    ;(adapter as unknown as { tmux: TmuxDriver }).tmux = new DeadTmux()
    await expect(adapter.state(h)).resolves.toBe('exited')

    expect(seen).toEqual([{ state: 'exited', endReason: 'completed' }])
  })

  it('本进程 kill → 回调 report.endReason 上报 killed(这一档是确证:只有 adapter 知道是不是自己动的手)', async () => {
    const seen: Array<{ state: WorkerContractState; endReason?: string }> = []
    const adapter = new ClaudeCodeAdapter({
      dataDir,
      claudeConfigPath: fakeClaudeConfig(dataDir),
      tmux: new NoopTmux(),
      claudeBin: 'unused',
      claudeProjectsDir,
      onStateChange: (_h, state, report) => {
        seen.push({ state, endReason: report?.endReason })
      },
    })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`
    const h = await adapter.spawn({ worker_id: workerId, prompt: '干活', workspace: { root: workspaceRoot } })

    await adapter.kill(h)

    expect(seen).toEqual([{ state: 'exited', endReason: 'killed' }])
  })
})

/**
 * 侧问(fork)收尾不得污染主线的 stop 计数。
 *
 * fork 的无头 `claude -p` 以 `cwd: workspaceRoot` 运行,而 provision 把 Stop hook 写在
 * **workspace 级**的 `.claude/settings.json` 里——cc 的 hooks 在 print 模式同样执行,
 * 所以侧问收尾也会触发同一条 Stop hook。事件文件又是 workspace 级共享的,于是这条
 * "侧问干完了"会被主线 runtime 的 watcher 当成"主线这一轮干完了"。
 *
 * 侧问设计上就是在主线还在跑的时候发起的(queryWorker 把 fork 放在锁外、不阻塞主线),
 * 两个症状因此必然成对出现:
 *   ① 主线跑到一半被判成 idle,推一条假的"这一轮干完了"去唤醒 manager;
 *   ② 主线随后真正跑完这一轮时 computed === runtime.state === 'idle',不再产生迁移,
 *      真正的轮次边界唤醒被整条吞掉。
 */
describe('ClaudeCodeAdapter.fork — 侧问收尾不污染主线 stop 计数', () => {
  let dataDir: string
  let workspaceRoot: string
  let claudeProjectsDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-forkstop-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-forkstop-ws-'))
    claudeProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-forkstop-proj-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
    await fs.rm(claudeProjectsDir, { recursive: true, force: true }).catch(() => {})
  })

  /** 复刻"cc 在 print 模式同样执行 workspace 级 Stop hook"的假二进制。 */
  function forkClaudeBinRunningStopHook(): string {
    return `env FAKE_FORK_RUN_STOP_HOOK=1 FAKE_FORK_STDOUT=${shQuote('侧问回复')} node ${shQuote(FAKE_CLAUDE_FORK)}`
  }

  async function stopCountIn(file: string): Promise<number> {
    const events = await new CliEventChannel(file).readAll()
    return events.filter((e) => e.kind === 'stop').length
  }

  async function mainlineStopHookFires(): Promise<void> {
    await fs.appendFile(
      eventsFilePath({ root: workspaceRoot }),
      JSON.stringify({ ts: new Date().toISOString(), kind: 'stop', raw: null }) + '\n',
      'utf-8',
    )
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('waitFor timeout')
  }

  it('侧问收尾的 stop 事件落进 fork 化身自己的事件文件,不进 workspace 共享事件文件', async () => {
    const adapter = new ClaudeCodeAdapter({
      dataDir,
      claudeConfigPath: fakeClaudeConfig(dataDir),
      tmux: new NoopTmux(),
      claudeBin: forkClaudeBinRunningStopHook(),
      claudeProjectsDir,
    })
    await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`
    const h1 = await adapter.spawn({ worker_id: workerId, prompt: '干活', workspace: { root: workspaceRoot } })

    const h2 = await adapter.fork({ worker_id: workerId, seq: 1, session_ref: h1.session_ref }, '侧问一下')

    // 前提:假二进制确实执行了 provision 写下的那条 Stop hook(否则本组用例是空跑)。
    expect(await stopCountIn(path.join(dataDir, workerId, `fork-events-${h2.seq}.jsonl`))).toBe(1)
    // 主线共享的那份事件文件必须一条都没多。
    expect(await stopCountIn(eventsFilePath({ root: workspaceRoot }))).toBe(0)

    await adapter.kill(h1)
  })

  it('主线在跑时发起侧问:① 主线不被误判 idle;② 主线真正跑完那一轮的唤醒不被吞', async () => {
    const seen: Array<{ seq: number; state: WorkerContractState }> = []
    const adapter = new ClaudeCodeAdapter({
      dataDir,
      claudeConfigPath: fakeClaudeConfig(dataDir),
      tmux: new NoopTmux(),
      claudeBin: forkClaudeBinRunningStopHook(),
      claudeProjectsDir,
      onStateChange: (h, state) => {
        seen.push({ seq: h.seq, state })
      },
    })
    await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
    const workerId = `cctest-${randomUUID().slice(0, 8)}`
    // 主线:spawn 之后一直在跑(NoopTmux.isAlive 恒 true,主线自己还没写过 stop)。
    const h1 = await adapter.spawn({ worker_id: workerId, prompt: '干活', workspace: { root: workspaceRoot } })

    // 侧问在主线还在跑的时候发起。
    await adapter.fork({ worker_id: workerId, seq: 1, session_ref: h1.session_ref }, '侧问一下')

    // ① 侧问收尾之后(留足 watcher 快路径 + 2s 轮询兜底的时间),主线不能被判成 idle。
    await new Promise((r) => setTimeout(r, 2500))
    expect(seen.filter((e) => e.seq === h1.seq && e.state === 'idle')).toHaveLength(0)

    // ② 主线真正跑完这一轮 → 轮次边界唤醒必须如约推出来。
    await mainlineStopHookFires()
    await waitFor(() => seen.some((e) => e.seq === h1.seq && e.state === 'idle'))
    expect(seen.filter((e) => e.seq === h1.seq && e.state === 'idle')).toHaveLength(1)

    await adapter.kill(h1)
  }, 15000)
})

/**
 * ensureRuntime 并发重建:重启后同一化身被并发首次触达(如启动对账的 state() 与 recovery
 * 触发的 sendInput() 同时到达)时,两次调用各自重建一个 Runtime、各装一个 watcher,
 * 后 set 的胜出——败者被自己 watcher 的闭包持有,transitionExited 只摘胜者的,败者的
 * fs.watch + 2s 轮询到进程退出为止一直活着,每个轮次边界都重复唤醒一次。
 */
describe('ClaudeCodeAdapter.ensureRuntime — 并发重建不泄漏 watcher', () => {
  let dataDir: string
  let workspaceRoot: string
  let claudeProjectsDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-concurrent-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-concurrent-ws-'))
    claudeProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-adapter-concurrent-proj-'))
    await fs.mkdir(path.join(workspaceRoot, '.claude'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
    await fs.rm(claudeProjectsDir, { recursive: true, force: true }).catch(() => {})
  })

  it('并发首次触达同一化身:每个 stop 事件只唤醒一次,化身退出后也没有残留 watcher 继续推', async () => {
    const workerId = `cctest-${randomUUID().slice(0, 8)}`
    const sessionId = randomUUID()
    // 模拟"重启前留下的落盘化身":新 adapter 实例的 runtimes 为空,只能从 meta 重建。
    await fs.mkdir(path.join(dataDir, workerId), { recursive: true })
    await fs.writeFile(
      path.join(dataDir, workerId, 'meta-1.json'),
      JSON.stringify({ seq: 1, state: 'running', session_id: sessionId, workspace_root: workspaceRoot }),
      'utf-8',
    )

    class ToggleTmux extends NoopTmux {
      alive = true
      async isAlive(_name: string): Promise<boolean> {
        return this.alive
      }
    }
    const tmux = new ToggleTmux()
    const seen: WorkerContractState[] = []
    const adapter = new ClaudeCodeAdapter({
      dataDir,
      claudeConfigPath: fakeClaudeConfig(dataDir),
      tmux,
      claudeBin: 'unused',
      claudeProjectsDir,
      onStateChange: (_h, state) => {
        seen.push(state)
      },
    })
    const h: IncarnationHandle = { worker_id: workerId, seq: 1, impl: 'claude-code', session_ref: sessionId }

    const [a, b] = await Promise.all([adapter.state(h), adapter.state(h)])
    expect([a, b]).toEqual(['running', 'running'])

    const appendStop = () =>
      fs.appendFile(
        eventsFilePath({ root: workspaceRoot }),
        JSON.stringify({ ts: new Date().toISOString(), kind: 'stop', raw: null }) + '\n',
        'utf-8',
      )
    const waitFor = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise((r) => setTimeout(r, 50))
      }
      throw new Error('waitFor timeout')
    }

    // 一次轮次边界只能唤醒一次。
    await appendStop()
    await waitFor(() => seen.length > 0)
    await new Promise((r) => setTimeout(r, 500))
    expect(seen).toEqual(['idle'])

    // 化身退出:胜者的 watcher 在 transitionExited 里被摘掉。若并发重建留下了第二个
    // runtime,它的 watcher 仍然活着,同一条事件会被再推一次。
    tmux.alive = false
    await appendStop()
    await waitFor(() => seen.includes('exited'))
    await new Promise((r) => setTimeout(r, 500))
    expect(seen).toEqual(['idle', 'exited'])
  }, 15000)
})

/**
 * 启动期就绪握手(spec: 2026-08-04-cli-worker-readiness-design)。
 *
 * 生产事故:cc 要到 pane 输出的 byte 871/1043 才发 `\e[?2004h`,而 prompt 在 byte 0 就被
 * 打进去了。tmux `paste-buffer -p` 在目标程序尚未请求 bracketed paste 时静默降级成裸文本
 * 注入 —— prompt 里每个换行都变成一次 Enter,前两个分别确认掉信任弹窗与 MCP 弹窗,残句留在
 * composer 里从未提交,worker 静默停在 running 8.5 小时。
 *
 * 这里用 MOCK_CLI_PASTE_READY_DELAY_MS 复刻那个时序:mock 从进程一起来就读 stdin,但推迟
 * 发出 `\e[?2004h`。tmux 是否包裹 paste 标记由它自己跟踪的 pane 模式决定,所以这套复现是
 * 真的走了同一条降级路径,不是模拟出来的。
 */
describe.skipIf(!tmuxAvailable)('ClaudeCodeAdapter — 启动期就绪握手(\\e[?2004h)', () => {
  /** 记录 sendText 调用,其余行为完全走真实 TmuxDriver —— 超时分支要断言的是"一次都没调"。 */
  class SpyTmux extends TmuxDriver {
    readonly sendTextCalls: Array<{ name: string; text: string }> = []
    async sendText(name: string, text: string): Promise<void> {
      this.sendTextCalls.push({ name, text })
      return super.sendText(name, text)
    }
  }

  let dataDir: string
  let workspaceRoot: string
  let stdinLog: string
  let tmux: SpyTmux

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-ready-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-ready-ws-'))
    stdinLog = path.join(dataDir, 'stdin.log')
    tmux = new SpyTmux()
  })

  afterEach(async () => {
    await cleanupTmuxSessions()
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  /** mock CLI 每次"提交"往 stdinLog 追一行 JSON(消息原文,含内部换行)。 */
  async function submissions(): Promise<string[]> {
    const raw = await fs.readFile(stdinLog, 'utf-8').catch(() => '')
    return raw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as string)
  }

  async function makeAdapter(opts: { readyDelayMs?: number; banner?: string; pasteReadyTimeoutMs?: number }) {
    const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
    const envParts = [
      `MOCK_CLI_SCRIPT=${shQuote('[]')}`,
      `MOCK_CLI_STOP_HOOK_CMD=${shQuote(channel.hookCommand('stop'))}`,
      `MOCK_CLI_STDIN_LOG=${shQuote(stdinLog)}`,
    ]
    if (opts.readyDelayMs) envParts.push(`MOCK_CLI_PASTE_READY_DELAY_MS=${opts.readyDelayMs}`)
    if (opts.banner) envParts.push(`MOCK_CLI_BANNER=${shQuote(opts.banner)}`)

    const seen: Array<{ state: WorkerContractState; report?: { outputTail?: string } }> = []
    const adapter = new ClaudeCodeAdapter({
      dataDir,
      claudeConfigPath: fakeClaudeConfig(dataDir),
      tmux,
      claudeBin: `env ${envParts.join(' ')} node ${shQuote(MOCK_CLI)}`,
      pasteReadyTimeoutMs: opts.pasteReadyTimeoutMs,
      onStateChange: (_h, state, report) => seen.push({ state, report }),
    })
    await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
    return { adapter, seen, workerId: `cctest-${randomUUID().slice(0, 8)}` }
  }

  const MULTILINE_PROMPT = ['任务:整理今天的 AI 早报', '背景:数据来自 GitHub trending', '验收:产出一篇 markdown'].join('\n')

  it(
    'TUI 迟迟不开 bracketed paste 时,prompt 不被拆成按键——握手等到之后整段一次提交',
    async () => {
      // 去掉就绪等待(把 waitForPasteReady 的结果当成恒 true)这条用例就挂:1.2s 的延迟窗口
      // 里 paste 不会被包裹,三行 prompt 会变成三次提交(且第一行还会先去确认掉弹窗)。
      const { adapter, workerId } = await makeAdapter({ readyDelayMs: 1200 })
      await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })

      // mock 收到 paste 是异步的,给它一点时间落 stdin 日志。
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && (await submissions()).length === 0) {
        await new Promise((r) => setTimeout(r, 50))
      }

      expect(await submissions()).toEqual([MULTILINE_PROMPT])
      expect(tmux.sendTextCalls).toHaveLength(1)
    },
    30000,
  )

  it(
    '等待期间进程自己死了 → 落 exited,不谎报 idle(那会让 manager 对着一具尸体发指令)',
    async () => {
      const adapter = new ClaudeCodeAdapter({
        dataDir,
        claudeConfigPath: fakeClaudeConfig(dataDir),
        tmux,
        // 启动即失败:pane 里的命令立刻退出,永远不会有就绪信号。
        claudeBin: `bash -c 'exit 1'`,
        pasteReadyTimeoutMs: 30_000, // 靠 isAlive 提前收工,不该等满
      })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `cctest-${randomUUID().slice(0, 8)}`

      const startedAt = Date.now()
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })
      expect(Date.now() - startedAt).toBeLessThan(15_000)

      expect(tmux.sendTextCalls).toEqual([])
      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
      expect(meta.state).toBe('exited')
      expect(await adapter.state(h)).toBe('exited')
    },
    40000,
  )

  it(
    '就绪立刻到位时不引入可观察的额外延迟(默认超时是 60s,不能变成每次都等)',
    async () => {
      const { adapter, workerId } = await makeAdapter({}) // 默认 60s 超时
      const startedAt = Date.now()
      await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })
      expect(Date.now() - startedAt).toBeLessThan(10_000)

      const deadline = Date.now() + 5000
      while (Date.now() < deadline && (await submissions()).length === 0) {
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(await submissions()).toEqual([MULTILINE_PROMPT])
    },
    30000,
  )

  it(
    '等不到就绪 → 一个字符都不投递(sendText 一次都不调),prompt 完好没被消耗',
    async () => {
      const { adapter, workerId } = await makeAdapter({ readyDelayMs: 600_000, pasteReadyTimeoutMs: 2000 })
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })

      expect(tmux.sendTextCalls).toEqual([])
      // 再等一会儿,确认不是"晚一点才发"——超时分支绝不能退化成降级继续发送。
      await new Promise((r) => setTimeout(r, 500))
      expect(tmux.sendTextCalls).toEqual([])
      expect(await submissions()).toEqual([])
      expect(h.session_ref).toMatch(/^[0-9a-f-]{36}$/) // cc 的 session id 是自己定的,不受影响
    },
    30000,
  )

  it(
    '等不到就绪 → 落 idle,并把 output 尾部随状态回调交给 manager(不 kill 现场)',
    async () => {
      const banner = 'New MCP server found in this project: arXivPaper'
      const { adapter, seen, workerId } = await makeAdapter({
        readyDelayMs: 600_000,
        pasteReadyTimeoutMs: 2000,
        banner,
      })
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })

      const idle = seen.filter((s) => s.state === 'idle')
      expect(idle).toHaveLength(1)
      expect(idle[0].report?.outputTail).toContain(banner)
      expect(idle[0].report?.outputTail).toContain('一个字符都没有投递')

      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
      expect(meta.state).toBe('idle')
      // 现场保留:进程还活着,manager 可以用 raw 敲键把界面清掉再重投。
      expect(await adapter.state(h)).not.toBe('exited')
    },
    30000,
  )

  it(
    '这条 idle 粘得住:再调 state() 不会被三源判定翻回 running(pane 活着 + stop 计数恒不涨)',
    async () => {
      // 五轮 review:去掉 syncState 里维持 startupStalled 的那一支,这条用例就挂——computed
      // 恒为 running,刚落的 idle 连同台账一起被翻回"正在干活",而这个 worker 的开工输入
      // 一个字符都没投递过。上一条用例只断言 not.toBe('exited'),观察不到这次翻转。
      const { adapter, workerId } = await makeAdapter({ readyDelayMs: 600_000, pasteReadyTimeoutMs: 2000 })
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })

      expect(await adapter.state(h)).toBe('idle')
      expect(await adapter.state(h)).toBe('idle') // 连续两次都不翻
      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
      expect(meta.state).toBe('idle')
      expect(meta.startup_stalled).toBe(true)
    },
    30000,
  )

  it(
    'agent 重启后仍然是 idle:暂扣态跟着 meta 落盘,reconcileOnStartup 的 state() 不会把台账拉回 running',
    async () => {
      const { adapter, workerId } = await makeAdapter({ readyDelayMs: 600_000, pasteReadyTimeoutMs: 2000 })
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })
      expect(await adapter.state(h)).toBe('idle')

      // 重启:新 adapter 实例,runtimes 必为空,一切从落盘 meta 重建(§13 重连接管)。
      const restarted = new ClaudeCodeAdapter({
        dataDir,
        claudeConfigPath: fakeClaudeConfig(dataDir),
        tmux,
        claudeBin: 'never-used-after-restart',
      })
      expect(await restarted.state(h)).toBe('idle')
    },
    30000,
  )

  it(
    'manager 出手(sendInput)之后暂扣解除:状态回到 running,落盘也不再带 startup_stalled',
    async () => {
      const { adapter, workerId } = await makeAdapter({ readyDelayMs: 600_000, pasteReadyTimeoutMs: 2000 })
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })
      expect(await adapter.state(h)).toBe('idle')

      await adapter.sendInput(h, 'Enter', { raw: true })

      expect(await adapter.state(h)).toBe('running')
      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
      expect(meta.state).toBe('running')
      expect(meta.startup_stalled).toBeUndefined()
    },
    30000,
  )

  it(
    '带给 manager 的 output 尾部是可读文本,不是转义序列——与 read_worker_output 同一形态',
    async () => {
      // 真实模态框是 TUI 重绘出来的:清屏、逐行绝对定位、SGR 上色。去掉 reportStartupStall 里
      // 那次 decodeTerminalOutput,manager 拿到的就是下面这串原样字节——而它同一时刻用
      // read_worker_output 读同一份日志拿到的是解码后的文本,同一份日志两种形态。
      const banner = [
        '\u001b[2J\u001b[H',
        '\u001b[3;1H\u001b[1;33mNew MCP server found in this project: arXivPaper\u001b[0m',
        '\u001b[4;1H  1. Use this MCP server',
        '\u001b[5;1H  2. No, exit',
      ].join('')
      const { adapter, seen, workerId } = await makeAdapter({
        readyDelayMs: 600_000,
        pasteReadyTimeoutMs: 2000,
        banner,
      })
      await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })

      const tail = seen.find((s) => s.state === 'idle')?.report?.outputTail
      expect(tail).toBeTruthy()
      // 一个 ESC 都不该剩:解码器丢掉所有控制序列,只留可见文本。
      expect(tail).not.toContain('\u001b')
      expect(tail).toContain('New MCP server found in this project: arXivPaper')
      // 行结构由光标定位构成,不是 \n:不解码的话这两个选项会粘在同一行上。
      expect(tail).toMatch(/1\. Use this MCP server\n\s*2\. No, exit/)
    },
    30000,
  )
})
