import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { CodexWorkerAdapter, eventsFilePath, WorkerExitedError } from '../../src/workers/codex/adapter.js'
import { ForkEstablishmentError } from '../../src/workers/errors.js'
import { TmuxDriver, type TmuxSessionSpec } from '../../src/workers/tmux/driver.js'
import type { TmuxControlEndpoint } from '../../src/workers/tmux/control-monitor.js'
import { CliEventChannel } from '../../src/workers/cli-events.js'
import {
  createTmpPageMcpServerConfig,
  TMP_PAGE_BRIDGE_ENV,
  TMP_PAGE_MCP_SERVER_NAME,
} from '../../src/workers/capability-policy.js'
import type { IncarnationHandle, SpawnSpec, StateChangeReport, WorkerContractState } from '../../src/workers/types.js'

function detectTmux(): boolean {
  const socket = `crabot-vitest-${process.pid}`
  try {
    execFileSync('which', ['tmux'], { stdio: 'ignore' })
    execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'probe', 'exit 0'], { stdio: 'ignore' })
    execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' })
    return true
  } catch {
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }) } catch {}
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
const FAKE_CODEX_APP_SERVER = path.resolve(__dirname, 'fixtures/fake-codex-app-server.mjs')

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
function codexBinFor(script: MockStep[], stopHookCmd: string, opts?: { argvFile?: string; rolloutFile?: string; rolloutOnSubmit?: boolean; pasteReadyDelayMs?: number }): string {
  const argvEnv = opts?.argvFile ? `MOCK_CLI_ARGV_FILE=${shQuote(opts.argvFile)} ` : ''
  const rolloutEnv = opts?.rolloutFile ? `MOCK_CLI_ROLLOUT_FILE=${shQuote(opts.rolloutFile)} ` : ''
  const rolloutTimingEnv = opts?.rolloutOnSubmit ? 'MOCK_CLI_ROLLOUT_ON_SUBMIT=1 ' : ''
  const readyDelayEnv = opts?.pasteReadyDelayMs ? `MOCK_CLI_PASTE_READY_DELAY_MS=${opts.pasteReadyDelayMs} ` : ''
  return `env MOCK_CLI_SCRIPT=${shQuote(JSON.stringify(script))} MOCK_CLI_STOP_HOOK_CMD=${shQuote(stopHookCmd)} ${argvEnv}${rolloutEnv}${rolloutTimingEnv}${readyDelayEnv}node ${shQuote(MOCK_CLI)}`
}

/** 假 TmuxDriver 的就绪控制端点；测试不再伪造 pipe-pane 原始输出文件。 */
const READY_CONTROL_ENDPOINT: TmuxControlEndpoint = {
  socket_path: '/tmp/crabot-test-ready.sock',
  monitor_id: 'crabot-test-ready',
}

async function fakeReadyNewSession(_spec: TmuxSessionSpec): Promise<TmuxControlEndpoint> {
  return READY_CONTROL_ENDPOINT
}

/** 扮演"已经就绪的 TUI"的最小 pane 命令:先请求 bracketed paste 再挂住不退。理由同上。 */
const READY_IDLE_BIN = `bash -c 'printf "\\033[?2004h"; sleep 5'`

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

function terminalText(view: Awaited<ReturnType<CodexWorkerAdapter['readTerminal']>>): string {
  return view.kind === 'unavailable' ? '' : view.text
}

async function writeGeneratedCodexHookConfig(workspaceRoot: string): Promise<void> {
  const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
  await fs.mkdir(path.join(workspaceRoot, '.codex'), { recursive: true })
  await fs.writeFile(
    path.join(workspaceRoot, '.codex', 'config.toml'),
    stringifyToml({
      features: { hooks: true },
      hooks: {
        PermissionRequest: [{
          matcher: '',
          hooks: [{
            type: 'command',
            command: `/bin/sh -c ${shQuote(channel.hookCommand('permission_request'))}`,
            timeout: 10,
          }],
        }],
      },
    }),
    'utf-8',
  )
}

async function injectUntrustedCodexConfigSources(configPath: string): Promise<void> {
  const config = parseToml(await fs.readFile(configPath, 'utf-8')) as Record<string, unknown>
  config.allow_managed_hooks_only = true
  config.plugins = { worker_plugin: { enabled: true } }
  config.marketplaces = { worker_marketplace: { source: 'https://example.invalid/plugin' } }
  config.hooks = {
    WorkerAdded: [{ matcher: '', hooks: [] }],
    state: { host_hook: { trusted_hash: 'sha256:host' } },
  }
  await fs.writeFile(configPath, stringifyToml(config), 'utf-8')
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

  it('写出 .codex/config.toml(notify 段在 mcp_servers 表头之前)，不改写 workspace 规则文件', async () => {
    execFileSync('git', ['init', '-q'], { cwd: ws })
    await fs.writeFile(path.join(codexHomeSource, 'auth.json'), '{"token":"secret-auth"}', 'utf-8')
    const adapter = new CodexWorkerAdapter({ dataDir: ws, codexHomeSource })
    await adapter.provision({ root: ws }, {
      skills: [],
      mcp_servers: [
        { name: 'x', transport: 'stdio', command: 'node', env: { API_KEY: 'secret' } },
        { name: 'remote', transport: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer token' } },
      ],
    })

    const configPath = path.join(ws, '.codex/config.toml')
    const configToml = await fs.readFile(configPath, 'utf-8')
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600)
    expect(configToml).toContain('notify = ')
    expect(configToml).toContain('events-cli.jsonl')
    expect(configToml).toContain('permission_request')
    // 序列化交给 smol-toml 之后表头是否给 key 加引号属于格式细节(`[mcp_servers.x]` 与
    // `[mcp_servers."x"]` 语义等价),这里钉语义不钉引号风格。
    expect((parseToml(configToml) as any).mcp_servers).toEqual({
      x: { command: 'node', env: { API_KEY: 'secret' } },
      remote: { url: 'https://example.com/mcp', http_headers: { Authorization: 'Bearer token' } },
    })
    const hooks = (parseToml(configToml) as any).hooks
    expect(hooks.PermissionRequest).toHaveLength(1)
    expect(hooks.PermissionRequest[0].hooks[0]).toMatchObject({
      type: 'command',
      timeout: 10,
    })
    expect(hooks.PermissionRequest[0].hooks[0].command).toContain('permission_request')
    // TOML 根级 key(notify)必须出现在第一个 table([mcp_servers...])之前。
    expect(configToml.indexOf('notify =')).toBeLessThan(configToml.indexOf('[mcp_servers'))

    // ignore 在敏感写入前已存在，普通 git add -A 不收录目标或 crash temp。
    const crashTemp = path.join(ws, '.codex', '.config.toml.tmp-crash-fixture')
    await fs.writeFile(crashTemp, 'API_KEY=stale-secret\n', { mode: 0o600 })
    execFileSync('git', ['add', '-A'], { cwd: ws })
    for (const relativePath of ['.codex/config.toml', '.codex/auth.json', '.codex/.config.toml.tmp-crash-fixture']) {
      expect(() => execFileSync('git', ['ls-files', '--error-unmatch', '--', relativePath], { cwd: ws, stdio: 'ignore' })).toThrow()
    }

    await expect(fs.access(path.join(ws, 'AGENTS.md'))).rejects.toThrow()
    await expect(fs.access(path.join(ws, 'CLAUDE.md'))).rejects.toThrow()
  })

  it('把 task-scoped tmp-page bridge 的 argv、env 和 worker 绑定原样物化到 config.toml', async () => {
    const server = createTmpPageMcpServerConfig('worker-codex', {
      command: process.execPath,
      args: ['/opt/crabot/crabot-agent/dist/mcp/tmp-page-stdio-server.js'],
      dataDir: '/var/lib/crabot',
      baseUrl: 'https://pages.example.test',
      port: 19099,
    })
    const adapter = new CodexWorkerAdapter({ dataDir: ws, codexHomeSource })
    await adapter.provision({ root: ws }, { skills: [], mcp_servers: [server] })

    const rendered = parseToml(await fs.readFile(path.join(ws, '.codex/config.toml'), 'utf-8')) as any
    expect(rendered.mcp_servers[TMP_PAGE_MCP_SERVER_NAME]).toEqual({
      command: process.execPath,
      args: ['/opt/crabot/crabot-agent/dist/mcp/tmp-page-stdio-server.js'],
      env: {
        [TMP_PAGE_BRIDGE_ENV.dataDir]: '/var/lib/crabot',
        [TMP_PAGE_BRIDGE_ENV.baseUrl]: 'https://pages.example.test',
        [TMP_PAGE_BRIDGE_ENV.workerId]: 'worker-codex',
        [TMP_PAGE_BRIDGE_ENV.port]: '19099',
      },
    })
  })

  it.each(['config.toml', 'auth.json'])('拒绝覆盖 Git 已跟踪的 .codex/%s，且在其他 provision 写入前失败', async (fileName) => {
    execFileSync('git', ['init', '-q'], { cwd: ws })
    const codexDir = path.join(ws, '.codex')
    await fs.mkdir(codexDir, { recursive: true })
    const trackedPath = path.join(codexDir, fileName)
    await fs.writeFile(trackedPath, 'user-owned\n', 'utf-8')
    execFileSync('git', ['add', `.codex/${fileName}`], { cwd: ws })

    const adapter = new CodexWorkerAdapter({ dataDir: ws, codexHomeSource })
    await expect(adapter.provision({ root: ws }, {
      skills: [],
      mcp_servers: [{ name: 'x', transport: 'stdio', command: 'node', env: { API_KEY: 'secret' } }],
    })).rejects.toThrow(new RegExp(`refusing to overwrite tracked \\.codex/${fileName.replace('.', '\\.')}`))

    expect(await fs.readFile(trackedPath, 'utf-8')).toBe('user-owned\n')
    await expect(fs.access(path.join(codexDir, '.gitignore'))).rejects.toThrow()
    await expect(fs.access(path.join(ws, 'AGENTS.md'))).rejects.toThrow()
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

  it.each(['hooks.json', 'plugins'] as const)('已有 .codex/%s 时拒绝启用自动 hook trust', async (entry) => {
    const target = path.join(ws, '.codex', entry)
    await fs.mkdir(path.dirname(target), { recursive: true })
    if (entry === 'plugins') await fs.mkdir(target)
    else await fs.writeFile(target, '{}\n', 'utf-8')

    const adapter = new CodexWorkerAdapter({ dataDir: ws, codexHomeSource })
    await expect(adapter.provision({ root: ws }, { skills: [], mcp_servers: [] })).rejects.toThrow(
      new RegExp(`refusing to enable generated hook trust.*${entry.replace('.', '\\.')}`),
    )
    await expect(fs.access(path.join(ws, '.codex', 'config.toml'))).rejects.toThrow()
  })

  it('provision 后新出现的 hook 源会在 spawn 前被拒绝，不创建 tmux 会话', async () => {
    class CountingTmux extends TmuxDriver {
      newSessionCalls = 0

      async newSession(spec: TmuxSessionSpec): Promise<TmuxControlEndpoint> {
        this.newSessionCalls += 1
        return fakeReadyNewSession(spec)
      }
    }

    const tmux = new CountingTmux()
    const adapter = new CodexWorkerAdapter({ dataDir: ws, codexHomeSource, tmux, codexBin: 'unused' })
    await adapter.provision({ root: ws }, { skills: [], mcp_servers: [] })
    await fs.writeFile(path.join(ws, '.codex', 'hooks.json'), '{}\n', 'utf-8')

    await expect(adapter.spawn({ worker_id: 'spawn-hook-race', prompt: '你好', workspace: { root: ws } })).rejects.toThrow(
      /CodexWorkerAdapter\.spawn: refusing to enable generated hook trust/,
    )
    expect(tmux.newSessionCalls).toBe(0)
  })

  it('spawn 前会清除 config.toml 中的未知 hook 源，仅留下生成的 PermissionRequest hook', async () => {
    class CountingTmux extends NoopTmux {
      newSessionCalls = 0

      async newSession(spec: TmuxSessionSpec): Promise<TmuxControlEndpoint> {
        this.newSessionCalls += 1
        return super.newSession(spec)
      }
    }

    const tmux = new CountingTmux()
    const adapter = new CodexWorkerAdapter({ dataDir: ws, codexHomeSource, tmux, codexBin: 'unused', sessionDiscoveryTimeoutMs: 50 })
    await adapter.provision({ root: ws }, { skills: [], mcp_servers: [] })
    await injectUntrustedCodexConfigSources(path.join(ws, '.codex', 'config.toml'))

    const h = await adapter.spawn({ worker_id: 'spawn-hook-config-race', prompt: '你好', workspace: { root: ws } })
    const config = parseToml(await fs.readFile(path.join(ws, '.codex', 'config.toml'), 'utf-8')) as {
      features: { hooks: unknown }
      hooks: Record<string, unknown>
      plugins?: unknown
      marketplaces?: unknown
      allow_managed_hooks_only?: unknown
    }
    expect(config.features.hooks).toBe(true)
    expect(config.hooks.PermissionRequest).toEqual(expect.any(Array))
    expect(config.hooks.WorkerAdded).toBeUndefined()
    expect(config.hooks.state).toBeUndefined()
    expect(config.plugins).toBeUndefined()
    expect(config.marketplaces).toBeUndefined()
    expect(config.allow_managed_hooks_only).toBeUndefined()
    expect(tmux.newSessionCalls).toBe(1)
    await adapter.kill(h)
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

  // ── provision 继承宿主 ~/.codex/config.toml ──────────────────────────────
  // 生产事故:.codex 被重定向成隔离 CODEX_HOME 后,auth.json 搬了、config.toml 没搬,
  // 于是 key 是给 mirror 的、endpoint 却回落到官方 api.openai.com,报 401。
  // 隔离 home 就必须整份继承宿主登录态,不只是凭据。
  describe('继承宿主 config.toml', () => {
    /** 不含任何凭据的宿主配置样例——固件里绝不放真实/仿真 key。 */
    const HOST_CONFIG = [
      'model = "gpt-5-codex"',
      'model_provider = "custom"',
      'disable_response_storage = true',
      '',
      '[model_providers.custom]',
      'name = "mirror"',
      'base_url = "https://mirror.xinshu.ai"',
      'wire_api = "responses"',
      '',
    ].join('\n')

    async function provisionWithHost(
      hostToml: string | null,
      mcp: { name: string; transport: 'stdio'; command: string }[] = [],
    ): Promise<Record<string, any>> {
      if (hostToml !== null) {
        await fs.writeFile(path.join(codexHomeSource, 'config.toml'), hostToml, 'utf-8')
      }
      const adapter = new CodexWorkerAdapter({ dataDir: ws, codexHomeSource })
      await adapter.provision({ root: ws }, { skills: [], mcp_servers: mcp })
      const raw = await fs.readFile(path.join(ws, '.codex/config.toml'), 'utf-8')
      return parseToml(raw) as Record<string, any>
    }

    it('宿主的 model_provider / base_url 等被带进 workspace 配置(否则 key 搬了端点没搬)', async () => {
      const parsed = await provisionWithHost(HOST_CONFIG)

      expect(parsed.model).toBe('gpt-5-codex')
      expect(parsed.model_provider).toBe('custom')
      expect(parsed.disable_response_storage).toBe(true)
      expect(parsed.model_providers.custom.base_url).toBe('https://mirror.xinshu.ai')
      expect(parsed.model_providers.custom.wire_api).toBe('responses')
    })

    it('叠加后 crabot 自己的三块仍然正确(notify 可用 / trust_level 指向本 workspace / mcp_servers 是 crabot 的能力集)', async () => {
      const parsed = await provisionWithHost(HOST_CONFIG, [{ name: 'crabot', transport: 'stdio', command: 'node' }])
      const realRoot = await fs.realpath(ws)

      // notify:数组形式的程序契约,且指向本 workspace 的事件文件
      expect(Array.isArray(parsed.notify)).toBe(true)
      expect(parsed.notify[0]).toBe('/bin/sh')
      expect(parsed.notify.join(' ')).toContain('events-cli.jsonl')
      expect(parsed.notify[2]).toContain('</dev/null')

      // trust_level 必须存在且指向本 workspace 的 realpath
      expect(parsed.projects[realRoot]).toEqual({ trust_level: 'trusted' })

      // mcp_servers 是 crabot 的能力集
      expect(parsed.mcp_servers).toEqual({ crabot: { command: 'node' } })
    })

    it('宿主 hook、插件与 marketplace 配置不会进入隔离 worker，但生成的 PermissionRequest hook 保留', async () => {
      const hostWithHookSources = HOST_CONFIG + [
        'allow_managed_hooks_only = true',
        '',
        '[features]',
        'hooks = false',
        '',
        '[hooks.state.host_hook]',
        'trusted_hash = "sha256:host"',
        '',
        '[plugins.host_plugin]',
        'enabled = true',
        '',
        '[marketplaces.host_marketplace]',
        'source = "https://example.invalid/plugin"',
        '',
      ].join('\n')

      const parsed = await provisionWithHost(hostWithHookSources)

      expect(parsed.plugins).toBeUndefined()
      expect(parsed.marketplaces).toBeUndefined()
      expect(parsed.allow_managed_hooks_only).toBeUndefined()
      expect(parsed.features.hooks).toBe(true)
      expect(parsed.hooks.PermissionRequest).toHaveLength(1)
      expect(JSON.stringify(parsed.hooks)).toContain('permission_request')
      expect(JSON.stringify(parsed.hooks)).not.toContain('host_hook')
    })

    it('宿主的 [mcp_servers] 不与 crabot 的合并——caps 是任务授权边界,crabot 胜', async () => {
      const hostWithMcp = HOST_CONFIG + [
        '[mcp_servers.hostonly]',
        'command = "host-mcp"',
        '',
        '[mcp_servers.crabot]',
        'command = "host-version-of-crabot"',
        '',
      ].join('\n')

      const parsed = await provisionWithHost(hostWithMcp, [{ name: 'crabot', transport: 'stdio', command: 'node' }])

      // 宿主独有的 server 不得被带进来(否则宿主配置能扩大 worker 的授权边界)
      expect(parsed.mcp_servers.hostonly).toBeUndefined()
      // 同名冲突时 crabot 的定义胜出
      expect(parsed.mcp_servers).toEqual({ crabot: { command: 'node' } })
    })

    it('宿主已有的 [projects."别的目录"] 一并带过来,但不挤掉 crabot 为本 workspace 写的那条', async () => {
      const hostWithProjects = HOST_CONFIG + [
        '[projects."/some/other/host/dir"]',
        'trust_level = "trusted"',
        '',
      ].join('\n')

      const parsed = await provisionWithHost(hostWithProjects)
      const realRoot = await fs.realpath(ws)

      expect(parsed.projects['/some/other/host/dir']).toEqual({ trust_level: 'trusted' })
      expect(parsed.projects[realRoot]).toEqual({ trust_level: 'trusted' })
    })

    it('TOML 根级 key 排在所有 table 之前——用解析结果验证,不是字符串包含', async () => {
      const parsed = await provisionWithHost(HOST_CONFIG, [{ name: 'crabot', transport: 'stdio', command: 'node' }])

      // 根级 key 若排到 [model_providers.custom] 之后,TOML 语义上会变成那个表的子字段:
      // 顶层读不到 notify,反而在表里冒出来。两侧都钉住才能真正抓到排序退化。
      expect(parsed.notify).toBeDefined()
      expect(parsed.model_provider).toBe('custom')
      expect(parsed.model_providers.custom.notify).toBeUndefined()
      expect(parsed.model_providers.custom.model_provider).toBeUndefined()
      expect(parsed.projects[await fs.realpath(ws)].notify).toBeUndefined()
      expect(parsed.mcp_servers.crabot.notify).toBeUndefined()
    })

    it('宿主没有 config.toml(全新机器)→ 干净降级成只有 crabot 三块', async () => {
      const parsed = await provisionWithHost(null, [{ name: 'crabot', transport: 'stdio', command: 'node' }])
      const realRoot = await fs.realpath(ws)

      expect(parsed.notify).toBeDefined()
      expect(parsed.projects[realRoot]).toEqual({ trust_level: 'trusted' })
      expect(parsed.mcp_servers).toEqual({ crabot: { command: 'node' } })
      expect(parsed.model_provider).toBeUndefined()
    })

    it('宿主 config.toml 损坏 → provision 显式失败,且错误消息不带文件内容', async () => {
      // 静默降级会精确重现本次生产事故:key 在、端点错,而且无声无息。
      await fs.writeFile(
        path.join(codexHomeSource, 'config.toml'),
        'model_provider = "custom"\nbroken = [[[\n',
        'utf-8',
      )
      const adapter = new CodexWorkerAdapter({ dataDir: ws, codexHomeSource })

      await expect(adapter.provision({ root: ws }, { skills: [], mcp_servers: [] })).rejects.toThrow(
        /config\.toml/,
      )

      // 错误消息只能带路径 + 解析位置,不能把文件内容(可能含凭据)回显出来
      const err = await adapter
        .provision({ root: ws }, { skills: [], mcp_servers: [] })
        .then(() => null, (e: Error) => e)
      expect(err).not.toBeNull()
      expect(err!.message).toContain(path.join(codexHomeSource, 'config.toml'))
      expect(err!.message).not.toContain('model_provider')
      expect(err!.message).not.toContain('broken')
      expect(err!.message).not.toContain('[[[')
    })
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
    opts?: {
      withRollout?: boolean
      rolloutOnSubmit?: boolean
      onStateChange?: (h: IncarnationHandle, state: WorkerContractState, report?: StateChangeReport) => void
    },
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

    const codexBin = codexBinFor(script, stopHookCmd, { rolloutFile, rolloutOnSubmit: opts?.rolloutOnSubmit })
    // 测试用小轮询上限,避免"故意不配置 rollout 文件"的用例拖慢整个套件。
    const adapter = new CodexWorkerAdapter({
      dataDir,
      tmux,
      codexBin,
      sessionDiscoveryTimeoutMs: 1500,
      onStateChange: opts?.onStateChange,
    })
    // provision 建 .codex/ 目录——hook 写入目标目录必须先存在,否则 printf >> 静默失败。
    await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
    return { adapter, workerId: `codextest-${randomUUID().slice(0, 8)}`, rolloutUuid, rolloutFile }
  }

  function makeSpec(workerId: string, prompt: string): SpawnSpec {
    return { worker_id: workerId, prompt, workspace: { root: workspaceRoot } }
  }

  it(
    '① spawn → mock 输出 → notify → state 收敛 idle,终端画面可读',
    async () => {
      const { adapter, workerId } = await provisionedAdapter([{ output: '第一段输出', emitStop: true }])
      const h = await adapter.spawn(makeSpec(workerId, '你好'))

      await waitForState(adapter, h, 'idle')

      expect(terminalText(await adapter.readTerminal(h))).toContain('第一段输出')
    },
    15000,
  )

  it(
    '② sendInput 续答:第二段输出进入当前画面,再次收敛 idle',
    async () => {
      const { adapter, workerId } = await provisionedAdapter([
        { output: '第一段输出', emitStop: true },
        { output: '第二段输出', emitStop: true },
      ])
      const h = await adapter.spawn(makeSpec(workerId, '你好'))
      await waitForState(adapter, h, 'idle')

      expect(terminalText(await adapter.readTerminal(h))).toContain('第一段输出')

      await adapter.sendInput(h, '继续')
      await waitForState(adapter, h, 'idle')

      expect(terminalText(await adapter.readTerminal(h))).toContain('第二段输出')
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

  // ---- onStateChange 上报的 report.endReason:codex 上报的是**推断**,不是确证 ----

  it(
    '会话消失(非本进程 kill)→ 回调 report.endReason 上报 completed;这是推断,不表示任务真的成功',
    async () => {
      // ⚠️ 这条断言钉住的是 codex adapter 的**能力天花板**,不是"任务成功"这件事的证据。
      //
      // codex 的退出判定唯一依据是 `tmux.isAlive`(三源合成状态判定不看退出码):"会话没了
      // 且 runtime.killed 没置位" ⇒ 记 'completed'。codex 没有任何可得的任务成败信号——
      // 退出码没捕获(tmux 未设 remain-on-exit)、notify payload 只有 turn-complete、也没有
      // builtin 那样的 finish_task 结构化上报。所以一个失败退出的 codex worker 在这里同样
      // 会被记成 'completed'(协议 §6.3 已写明这条可信度分级)。
      //
      // 本次修复保证的是"harness 不再丢弃 adapter 已知的真值",不保证"所有实现都知道真值"。
      // 给 cc/codex 补终态上报是另一个设计任务,不在本次范围。
      const seen: Array<{ state: WorkerContractState; endReason?: string }> = []
      const { adapter, workerId } = await provisionedAdapter([{ output: '收尾输出', exit: true }], {
        onStateChange: (_h, state, report) => {
          seen.push({ state, endReason: report?.endReason })
        },
      })
      const h = await adapter.spawn(makeSpec(workerId, '你好'))

      await waitForState(adapter, h, 'exited')

      expect(h.initial_input).toMatchObject({
        control_state: 'exited',
        disposition: 'accepted',
        report: { endReason: 'completed' },
      })
      expect(seen).toEqual([])
    },
    15000,
  )

  it(
    '本进程 kill → 回调 report.endReason 上报 killed(这一档是确证:只有 adapter 知道是不是自己动的手)',
    async () => {
      const seen: Array<{ state: WorkerContractState; endReason?: string }> = []
      const { adapter, workerId } = await provisionedAdapter([{ output: '还在跑' }], {
        onStateChange: (_h, state, report) => {
          seen.push({ state, endReason: report?.endReason })
        },
      })
      const h = await adapter.spawn(makeSpec(workerId, '你好'))

      await adapter.kill(h)

      expect(seen).toContainEqual({ state: 'exited', endReason: 'killed' })
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
    'session 发现:Codex 0.146 式 rollout 在首条 submit 后才出现，spawn 返回真实 session_ref',
    async () => {
      const { adapter, workerId, rolloutUuid } = await provisionedAdapter(
        [{ output: '第一段输出', emitStop: true }],
        { withRollout: true, rolloutOnSubmit: true },
      )
      const h = await adapter.spawn(makeSpec(workerId, '你好'))
      expect(h.initial_input).toMatchObject({ disposition: 'accepted' })
      expect(h.session_ref).toBe(rolloutUuid)
      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string; session_discovery?: string }
      expect(meta).toMatchObject({ session_id: rolloutUuid, session_discovery: 'discovered' })
    },
    15000,
  )

  it(
    'session 发现:startup stall 经 raw 清障后不编占位 id，首条普通输入接受后才发现 rollout',
    async () => {
      const rolloutUuid = randomUUID()
      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const datePath = path.join(String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
      const rolloutFile = path.join(workspaceRoot, '.codex', 'sessions', datePath, rolloutFileNameFor(rolloutUuid))
      const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
      const seen: Array<{ state: WorkerContractState; sessionRef?: string }> = []
      const codexBin = codexBinFor(
        [
          { output: 'raw 清障回合', emitStop: true },
          { output: '首条任务完成', emitStop: true },
        ],
        channel.hookCommand('stop'),
        { rolloutFile, rolloutOnSubmit: true, pasteReadyDelayMs: 200 },
      )
      const adapter = new CodexWorkerAdapter({
        dataDir,
        tmux,
        codexBin,
        pasteReadyTimeoutMs: 50,
        sessionDiscoveryTimeoutMs: 1500,
        onStateChange: (handle, state) => seen.push({ state, sessionRef: handle.session_ref }),
      })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `codextest-${randomUUID().slice(0, 8)}`
      const h = await adapter.spawn(makeSpec(workerId, '首条任务'))
      expect(h).toMatchObject({ session_ref: '', initial_input: { disposition: 'not_pasted', control_state: 'waiting_action' } })

      await new Promise((resolve) => setTimeout(resolve, 250))
      await adapter.sendInput(h, 'Enter', { raw: true })
      await waitForState(adapter, h, 'idle')
      expect((await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8'))).toContain('"session_id":""')

      await adapter.sendInput(h, '首条任务')
      expect(adapter.takeUpdatedSessionRef(h)).toBe(rolloutUuid)
      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string; session_discovery?: string }
      expect(meta).toMatchObject({ session_id: rolloutUuid, session_discovery: 'discovered' })
      const deadline = Date.now() + 5000
      while (!seen.some((event) => event.state === 'idle' && event.sessionRef === rolloutUuid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(seen).toContainEqual({ state: 'idle', sessionRef: rolloutUuid })
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
    '五轮 review PoC②:rollout 内容里的 session_id 不是合法 UUID(畸形值)时退回文件名解析出的 uuid,并打 warn' +
      '(修复前:内容里的 id 未经格式校验就直接采信,畸形 id 会写进 meta.session_id/handle.session_ref,spawn 静默成功但 resume 必然失败)',
    async () => {
      const { adapter, workerId } = await provisionedAdapter([{ output: '第一段输出', emitStop: true }])
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const uuidFromFilename = randomUUID()
      const malformedContentId = 'not-a-valid-uuid; rm -rf /'

      const spawnPromise = adapter.spawn(makeSpec(workerId, '你好'))

      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const datePath = path.join(String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
      const sessionsDir = path.join(workspaceRoot, '.codex', 'sessions', datePath)
      await fs.mkdir(sessionsDir, { recursive: true })
      await fs.writeFile(
        path.join(sessionsDir, rolloutFileNameFor(uuidFromFilename)),
        JSON.stringify({ type: 'session_meta', payload: { session_id: malformedContentId, timestamp: new Date().toISOString(), cwd: workspaceRoot } }) + '\n',
        'utf-8',
      )

      const h = await spawnPromise
      await waitForState(adapter, h, 'idle')

      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string; session_discovery?: string }
      // 退回文件名解析出的 uuid,不是畸形内容值。
      expect(meta.session_id).toBe(uuidFromFilename)
      expect(meta.session_id).not.toBe(malformedContentId)
      expect(meta.session_discovery).toBe('discovered')
      expect(h.session_ref).toBe(uuidFromFilename)

      const warned = warnSpy.mock.calls.some((call) => String(call[0] ?? '').includes('not a valid UUID'))
      expect(warned).toBe(true)

      warnSpy.mockRestore()
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
      const { adapter, workerId } = await provisionedAdapter([{ output: '主线输出', exit: true }], { withRollout: true })
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
    'spawn command uses approve-for-me with network access',
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
      expect(argv).not.toContain('--yolo')
      expect(argv).toContain('--approve-for-me')
      expect(argv).toContain('--dangerously-bypass-hook-trust')
      expect(argv).not.toContain('--ask-for-approval')
      expect(argv).not.toContain('--sandbox')
      const configIdx = argv.indexOf('-c')
      expect(configIdx).toBeGreaterThan(-1)
      expect(argv[configIdx + 1]).toBe('sandbox_workspace_write.network_access=true')

      await adapter.kill(h)
    },
    15000,
  )

  it(
    'resume command uses approve-for-me before resume with network access',
    async () => {
      const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
      const stopHookCmd = channel.hookCommand('stop')
      const argvFile = path.join(dataDir, 'resume-argv.jsonl')
      const rolloutFile = path.join(workspaceRoot, '.codex', 'sessions', rolloutFileNameFor(randomUUID()))
      const codexBin = codexBinFor([{ output: '主线输出', exit: true }], stopHookCmd, { argvFile, rolloutFile })
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
      expect(argv).not.toContain('--yolo')
      const resumeIdx = argv.indexOf('resume')
      expect(resumeIdx).toBeGreaterThan(-1)
      for (const flag of ['--approve-for-me', '-c', '--dangerously-bypass-hook-trust']) {
        const idx = argv.indexOf(flag)
        expect(idx).toBeGreaterThan(-1)
        expect(idx).toBeLessThan(resumeIdx)
      }
      expect(argv).toContain('--approve-for-me')
      expect(argv).not.toContain('--ask-for-approval')
      expect(argv).not.toContain('--sandbox')
      const configIdx = argv.indexOf('-c')
      expect(argv[configIdx + 1]).toBe('sandbox_workspace_write.network_access=true')
    },
    15000,
  )

  it(
    'resume 前会恢复 config.toml 的生成 hook，清除 Codex 或 worker 留下的未知 hook 源',
    async () => {
      const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
      const stopHookCmd = channel.hookCommand('stop')
      const argvFile = path.join(dataDir, 'resume-hook-race-argv.jsonl')
      const rolloutFile = path.join(workspaceRoot, '.codex', 'sessions', rolloutFileNameFor(randomUUID()))
      const codexBin = codexBinFor([{ output: '主线输出', exit: true }], stopHookCmd, { argvFile, rolloutFile })
      const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin, sessionDiscoveryTimeoutMs: 500 })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `codextest-${randomUUID().slice(0, 8)}`
      const h1 = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
      await waitForState(adapter, h1, 'exited')

      const meta1 = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8')) as { session_id: string }
      await injectUntrustedCodexConfigSources(path.join(workspaceRoot, '.codex', 'config.toml'))

      const h2 = await adapter.resume({ worker_id: workerId, seq: 1, session_ref: meta1.session_id }, '继续')
      const config = parseToml(await fs.readFile(path.join(workspaceRoot, '.codex', 'config.toml'), 'utf-8')) as {
        features: { hooks: unknown }
        hooks: Record<string, unknown>
        plugins?: unknown
        marketplaces?: unknown
        allow_managed_hooks_only?: unknown
      }
      expect(config.features.hooks).toBe(true)
      expect(config.hooks.PermissionRequest).toEqual(expect.any(Array))
      expect(config.hooks.WorkerAdded).toBeUndefined()
      expect(config.hooks.state).toBeUndefined()
      expect(config.plugins).toBeUndefined()
      expect(config.marketplaces).toBeUndefined()
      expect(config.allow_managed_hooks_only).toBeUndefined()
      expect((await fs.readFile(argvFile, 'utf-8')).trim().split('\n')).toHaveLength(2)
      await adapter.kill(h2)
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
      if (terminalText(await adapter.readTerminal(h)).includes(needle)) return
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`waitForOutputContains timeout: expected output to contain '${needle}'`)
  }

  it(
    'PoC①:会话仍存活——新 adapter 实例的 sendInput/kill 应真正作用于该会话(修复前:sendInput 直接抛通用 Error "no such incarnation...resident in this process")',
    async () => {
      const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
      const stopHookCmd = channel.hookCommand('stop')
      const codexBin = codexBinFor([{ output: '第一段输出', emitStop: true }, { output: '第二段输出' }], stopHookCmd)

      const adapterA = new CodexWorkerAdapter({ dataDir, tmux, codexBin, sessionDiscoveryTimeoutMs: 500 })
      await adapterA.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `codextest-${randomUUID().slice(0, 8)}`
      const h = await adapterA.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })

      await waitForOutputContains(adapterA, h, '第一段输出')
      await waitForState(adapterA, h, 'idle')

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
    'PoC②:自然退出的 dead pane 在 agent 重启后会被精确回收，新 adapter 的 sendInput 仍抛 WorkerExitedError',
    async () => {
      const codexBin = `bash -c 'printf "\\033[?2004h"; sleep 2'`

      const adapterA = new CodexWorkerAdapter({ dataDir, tmux, codexBin, sessionDiscoveryTimeoutMs: 500 })
      await adapterA.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `codextest-${randomUUID().slice(0, 8)}`
      const h = await adapterA.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
      const sessionName = `crabot-w-${workerId}-1`

      const deadline = Date.now() + 8000
      while (Date.now() < deadline && await tmux.isAlive(sessionName)) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(await tmux.capturePane(sessionName)).toMatchObject({ dead: true })

      const adapterB = new CodexWorkerAdapter({ dataDir, tmux, codexBin: 'unused-not-invoked-by-sendInput' })

      await expect(adapterB.sendInput(h, '还有件事')).rejects.toBeInstanceOf(WorkerExitedError)
      await expect(tmux.capturePane(sessionName)).rejects.toThrow()
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
      const rolloutFile = path.join(workspaceRoot, '.codex', 'sessions', rolloutFileNameFor(randomUUID()))
      const codexBin = codexBinFor([{ output: '输出', exit: true }], stopHookCmd, { rolloutFile })

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
  async newSession(spec: TmuxSessionSpec): Promise<TmuxControlEndpoint> {
    return this.current.newSession(spec)
  }
  async pasteText(name: string, text: string): Promise<void> {
    return this.current.pasteText(name, text)
  }
  async sendText(name: string, text: string): Promise<void> {
    return this.current.sendText(name, text)
  }
  async sendKeys(name: string, keys: string[]): Promise<void> {
    return this.current.sendKeys(name, keys)
  }
  async capturePane(name: string) {
    return this.current.capturePane(name)
  }
  async isAlive(name: string): Promise<boolean> {
    return this.current.isAlive(name)
  }
  async getPasteReadiness(endpoint: TmuxControlEndpoint) {
    return this.current.getPasteReadiness(endpoint)
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
      const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin: READY_IDLE_BIN, sessionDiscoveryTimeoutMs: 200 })
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
      expect(meta.state).toBe('idle')
      expect(h.initial_input).toMatchObject({ control_state: 'waiting_action', disposition: 'not_pasted' })

      await adapter.kill(h)
    },
    15000,
  )

  it(
    '首条 pasteText 失败时,不放任 running——按 kill 路径落 exited(crashed),spawn 仍 reject',
    async () => {
      class NewSessionOkSendTextFailsTmux extends TmuxDriver {
        killed = false
        async newSession(spec: TmuxSessionSpec): Promise<TmuxControlEndpoint> {
          return super.newSession(spec)
        }
        async capturePane(_name: string) {
          return { text: '› \n? for shortcuts' }
        }
        async pasteText(_name: string, _text: string): Promise<void> {
          throw new Error('simulated pasteText failure')
        }
        async killSession(name: string): Promise<void> {
          this.killed = true
          return super.killSession(name)
        }
      }
      const tmux = new NewSessionOkSendTextFailsTmux()
      const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin: READY_IDLE_BIN, sessionDiscoveryTimeoutMs: 200 })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `codextest-${randomUUID().slice(0, 8)}`
      const spec: SpawnSpec = { worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } }

      await expect(adapter.spawn(spec)).rejects.toThrow('simulated pasteText failure')

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
        async newSession(spec: TmuxSessionSpec): Promise<TmuxControlEndpoint> {
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
      const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin: codexPath, sessionDiscoveryTimeoutMs: 200, pasteReadyTimeoutMs: 500 })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `codextest-${randomUUID().slice(0, 8)}`
      const spec: SpawnSpec = { worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } }

      // 会话内的假 codex 立即退出,首条 sendText 大概率落空(会话已死)——只关心 newSession
      // 拿到的 env,spawn 本身是否 reject 不是这条用例的断言点。
      await adapter.spawn(spec).catch(() => {})

      expect(tmux.lastEnv).toBeDefined()
      expect(tmux.lastEnv!.PATH).toBe(`${await fs.realpath(toolDir)}:${process.env.PATH ?? ''}`)
      expect(tmux.lastEnv!.CODEX_HOME).toBe(path.join(workspaceRoot, '.codex'))

      await fs.rm(toolDir, { recursive: true, force: true }).catch(() => {})
    },
    15000,
  )

  it(
    '五轮 review PoC③:resolveBinDir 首次解析失败(codex 还没装好/PATH 未生效)不永久缓存 undefined——用户随后装好后,同一 adapter 实例下一次 spawn 应重新解析并前置 PATH' +
      '(修复前:cachedBinDir 固化第一次的 undefined,后续 spawn/resume 永远拿不到前置 PATH,直到 agent 重启才自愈)',
    async () => {
      class RecordingTmuxDriver extends TmuxDriver {
        envs: Array<Record<string, string> | undefined> = []
        async newSession(spec: TmuxSessionSpec): Promise<TmuxControlEndpoint> {
          this.envs.push(spec.env)
          return super.newSession(spec)
        }
      }
      const toolDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-bindir-retry-'))
      const fakeBinName = `crabot-test-fake-codex-${randomUUID().slice(0, 8)}`
      await fs.writeFile(path.join(toolDir, fakeBinName), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

      const originalPath = process.env.PATH ?? ''
      const tmux = new RecordingTmuxDriver()
      // 裸命令名(不含 '/'),命中 resolveBinDir 的 `command -v` 分支——对应真实 nvm 场景
      // (codex 是 PATH 上的一个命令名,不是绝对路径)。
      const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin: fakeBinName, sessionDiscoveryTimeoutMs: 200, pasteReadyTimeoutMs: 500 })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })

      try {
        // 第一次 spawn:toolDir 还不在 PATH 上,`command -v` 找不到,resolveBinDir 解析失败
        // → 回退到继承的 PATH(不前置任何目录)。
        const workerId1 = `codextest-${randomUUID().slice(0, 8)}`
        await adapter.spawn({ worker_id: workerId1, prompt: '你好', workspace: { root: workspaceRoot } }).catch(() => {})
        expect(tmux.envs[0]).toBeDefined()
        expect(tmux.envs[0]!.PATH).toBe(originalPath)

        // "用户随后装好了 codex"(如 nvm use / 重新 source shell rc)——把 toolDir 加进 PATH。
        process.env.PATH = `${toolDir}:${originalPath}`

        // 第二次 spawn,同一个 adapter 实例(不重启进程):resolveBinDir 应重新解析成功并
        // 前置 toolDir——PATH 里会出现两份 toolDir(一份是本次显式前置,一份已经在继承的
        // process.env.PATH 里)。修复前:cachedBinDir 固化了第一次的 undefined,PATH 只回退
        // 到(此时已含 toolDir 的)继承值,只有一份 toolDir,不会再前置——本用例正是靠"一份
        // 还是两份 toolDir"区分修复前后。
        const workerId2 = `codextest-${randomUUID().slice(0, 8)}`
        await adapter.spawn({ worker_id: workerId2, prompt: '你好', workspace: { root: workspaceRoot } }).catch(() => {})
        expect(tmux.envs[1]).toBeDefined()
        expect(tmux.envs[1]!.PATH).toBe(`${await fs.realpath(toolDir)}:${process.env.PATH}`)
      } finally {
        process.env.PATH = originalPath
        await fs.rm(toolDir, { recursive: true, force: true }).catch(() => {})
      }
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
    const invalidRefs = [' ', '$(whoami)', '`id`', '{test}', '../../../etc/passwd']

    for (const ref of invalidRefs) {
      await expect(
        adapter.resume({ worker_id: workerId, seq: 1, session_ref: ref }, 'payload'),
      ).rejects.toThrow(/invalid.*session_ref|UUID|session reference/i)
    }

    // 空串不是"格式写错了",而是启动期就绪握手超时时如实留下的"根本没有会话"——
    // 给它一句自己的错误,manager 才知道该 kill 重开而不是去修一个 id。
    await expect(adapter.resume({ worker_id: workerId, seq: 1, session_ref: '' }, 'payload')).rejects.toThrow(
      /has no codex session/,
    )
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

describe('CodexWorkerAdapter.fork — app-server', () => {
  let dataDir: string
  let workspaceRoot: string
  let codexHome: string
  let workerId: string
  let parentSessionId: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-fork-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-fork-ws-'))
    codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-fork-home-'))
    await fs.writeFile(path.join(codexHome, 'config.toml'), '', 'utf8')
    workerId = `codextest-${randomUUID().slice(0, 8)}`
    parentSessionId = randomUUID()
    const workerDir = path.join(dataDir, workerId)
    await fs.mkdir(workerDir, { recursive: true })
    await fs.writeFile(path.join(workerDir, 'meta-1.json'), JSON.stringify({
      seq: 1,
      state: 'running',
      session_id: parentSessionId,
      session_discovery: 'placeholder',
      workspace_root: workspaceRoot,
      codex_home: codexHome,
    }))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
    await fs.rm(codexHome, { recursive: true, force: true }).catch(() => {})
  })

  function appServerBin(mode = 'happy', extra = ''): string {
    return `env FAKE_APP_SERVER_MODE=${mode} ${extra} node ${shQuote(FAKE_CODEX_APP_SERVER)}`
  }

  function options(timeoutMs = 2000) {
    return {
      query_id: randomUUID(),
      establishment_deadline_at: new Date(Date.now() + timeoutMs).toISOString(),
      connection_env: { CODEX_HOME: codexHome },
    }
  }

  it('detect fail closed；当前 binary 通过方法/字段探测后才声明 fork=true', async () => {
    const unsupported = new CodexWorkerAdapter({
      dataDir,
      codexHomeSource: codexHome,
      codexBin: appServerBin('unsupported'),
    })
    await unsupported.detect()
    expect(unsupported.capabilities().fork).toBe(false)

    const supported = new CodexWorkerAdapter({
      dataDir,
      codexHomeSource: codexHome,
      codexBin: appServerBin(),
    })
    await supported.detect()
    expect(supported.capabilities().fork).toBe(true)
    expect(supported.capabilities().subagent).toBe(true)
  })

  it('读取 app-server 标记为 parentThreadId 的原生 child thread 与其独立 items，时间戳稳定', async () => {
    const childThreadId = randomUUID()
    const adapter = new CodexWorkerAdapter({
      dataDir,
      codexHomeSource: codexHome,
      tmux: new NoopTmux(),
      codexBin: appServerBin('children', `FAKE_CHILD_THREAD_ID=${childThreadId}`),
    })
    await adapter.detect()
    const parent = { worker_id: workerId, seq: 1, impl: 'codex' as const, session_ref: parentSessionId }

    await expect(adapter.listSubagents(parent)).resolves.toMatchObject([{
      subagent_id: childThreadId, executor_impl: 'codex', type: 'research', name: '研究助手', task: '原生子 Agent 任务', status: 'completed',
    }])
    const first = await adapter.readSubagentTrace(parent, childThreadId)
    const replay = await adapter.readSubagentTrace(parent, childThreadId)
    expect(first).toMatchObject({
      events: [
        { ts: '2026-02-02T02:40:10.000Z', kind: 'message', role: 'user', summary: '检查原生记录', source_offset: 0 },
        { ts: '2026-02-02T02:40:10.000Z', kind: 'tool_call', summary: 'exec_command(pwd)', source_offset: 1 },
        { ts: '2026-02-02T02:40:10.000Z', kind: 'message', role: 'assistant', summary: '原生子 Agent 已完成', source_offset: 2 },
      ],
      nextCursor: { offset: 3 },
    })
    expect(replay).toEqual(first)
  })

  it('detect 切换到同版本的另一 binary 时重新探测 fork capability', async () => {
    const unsupportedBin = path.join(dataDir, 'codex-unsupported')
    const supportedBin = path.join(dataDir, 'codex-supported')
    const wrapper = (mode: string) =>
      `#!/bin/sh\nexec env FAKE_APP_SERVER_MODE=${mode} node ${shQuote(FAKE_CODEX_APP_SERVER)} "$@"\n`
    await fs.writeFile(unsupportedBin, wrapper('unsupported'), { mode: 0o755 })
    await fs.writeFile(supportedBin, wrapper('happy'), { mode: 0o755 })
    let activeBin = unsupportedBin
    const adapter = new CodexWorkerAdapter({
      dataDir,
      codexHomeSource: codexHome,
      resolveUserLevelBinary: async () => ({ binary: activeBin, global_detected: false }),
    })

    await adapter.detect()
    expect(adapter.capabilities().fork).toBe(false)

    activeBin = supportedBin
    await adapter.detect()
    expect(adapter.capabilities().fork).toBe(true)
  })

  it('turn/start 接受后立即返回真实 fork thread，回答随后异步完成并写 output', async () => {
    const forkThreadId = randomUUID()
    const states: Array<{ state: WorkerContractState; endReason?: string }> = []
    const adapter = new CodexWorkerAdapter({
      dataDir,
      codexHomeSource: codexHome,
      tmux: new NoopTmux(),
      codexBin: appServerBin('happy', `FAKE_FORK_THREAD_ID=${forkThreadId} FAKE_COMPLETION_DELAY_MS=200`),
      onStateChange: (_handle, state, report) => states.push({ state, endReason: report?.endReason }),
    })
    await adapter.detect()

    const handle = await adapter.fork(
      { worker_id: workerId, seq: 1, session_ref: parentSessionId },
      '侧问问题',
      options(),
    )

    expect(handle).toMatchObject({
      worker_id: workerId,
      seq: 2,
      impl: 'codex',
      session_ref: forkThreadId,
    })
    expect(handle.session_ref).not.toBe(parentSessionId)
    expect(await adapter.state(handle)).toBe('running')

    await waitForState(adapter, handle, 'exited')
    await expect(adapter.readTerminal(handle)).resolves.toEqual({ kind: 'headless_text', text: '侧问回答' })
    expect(states).toContainEqual({ state: 'exited', endReason: 'completed' })
  })

  it('turn/start 明确拒绝时在同一次 fork 调用返回 query_submit 失败并收口进程', async () => {
    const terminationFile = path.join(dataDir, 'terminated.log')
    const adapter = new CodexWorkerAdapter({
      dataDir,
      codexHomeSource: codexHome,
      tmux: new NoopTmux(),
      codexBin: appServerBin('turn_error', `FAKE_TERMINATION_FILE=${shQuote(terminationFile)}`),
    })
    await adapter.detect()

    await expect(adapter.fork(
      { worker_id: workerId, seq: 1, session_ref: parentSessionId },
      '侧问问题',
      options(),
    )).rejects.toMatchObject({
      name: 'ForkEstablishmentError',
      stage: 'query_submit',
      certainty: 'not_started',
    } satisfies Partial<ForkEstablishmentError>)
    expect(await fs.readFile(terminationFile, 'utf8')).toContain('SIGTERM')
    await expect(fs.access(path.join(dataDir, workerId, 'meta-2.json'))).rejects.toThrow()
  })

  it('turn/start 返回不兼容 shape 时不能宣称首问确定未开始', async () => {
    const adapter = new CodexWorkerAdapter({
      dataDir,
      codexHomeSource: codexHome,
      tmux: new NoopTmux(),
      codexBin: appServerBin('bad_turn_shape'),
    })
    await adapter.detect()

    await expect(adapter.fork(
      { worker_id: workerId, seq: 1, session_ref: parentSessionId },
      '侧问问题',
      options(),
    )).rejects.toMatchObject({
      name: 'ForkEstablishmentError',
      stage: 'query_submit',
      certainty: 'unknown',
    } satisfies Partial<ForkEstablishmentError>)
    await expect(fs.access(path.join(dataDir, workerId, 'meta-2.json'))).rejects.toThrow()
  })

  it('建立 deadline 到期会失败并终止 app-server，不留下可误认成功的 meta', async () => {
    const terminationFile = path.join(dataDir, 'timeout-terminated.log')
    const adapter = new CodexWorkerAdapter({
      dataDir,
      codexHomeSource: codexHome,
      tmux: new NoopTmux(),
      codexBin: appServerBin('hang_fork', `FAKE_TERMINATION_FILE=${shQuote(terminationFile)}`),
    })
    await adapter.detect()

    await expect(adapter.fork(
      { worker_id: workerId, seq: 1, session_ref: parentSessionId },
      '侧问问题',
      options(100),
    )).rejects.toMatchObject({ name: 'ForkEstablishmentError', stage: 'timeout', certainty: 'unknown' })
    expect(await fs.readFile(terminationFile, 'utf8')).toContain('SIGTERM')
    await expect(fs.access(path.join(dataDir, workerId, 'meta-2.json'))).rejects.toThrow()
  })

  it('环境组装在 runtime 分配后失败时清理内存化身', async () => {
    let resolveCalls = 0
    const adapter = new CodexWorkerAdapter({
      dataDir,
      codexHomeSource: codexHome,
      tmux: new NoopTmux(),
      resolveUserLevelBinary: async () => {
        resolveCalls += 1
        if (resolveCalls === 1) return { binary: appServerBin(), global_detected: false }
        throw new Error('connection environment unavailable')
      },
    })
    ;(adapter as unknown as { appServerForkSupported: boolean }).appServerForkSupported = true

    await expect(adapter.fork(
      { worker_id: workerId, seq: 1, session_ref: parentSessionId },
      '侧问问题',
      options(),
    )).rejects.toMatchObject({
      name: 'ForkEstablishmentError',
      stage: 'fork_create',
      certainty: 'not_started',
    } satisfies Partial<ForkEstablishmentError>)

    expect((adapter as unknown as { runtimes: Map<string, unknown> }).runtimes.size).toBe(1)
    await expect(fs.access(path.join(dataDir, workerId, 'meta-2.json'))).rejects.toThrow()
  })
})

/** 全程无操作的假 TmuxDriver——readTrace 测试只需要一个"常驻 runtime"的化身,不关心 tmux 行为本身。 */
class NoopTmux extends TmuxDriver {
  paneText = '› \n? for shortcuts'
  alive = true
  pasteReadiness: 'ready' | 'not_ready' | 'unknown' = 'ready'
  pasteCalls = 0

  async newSession(spec: TmuxSessionSpec): Promise<TmuxControlEndpoint> {
    return fakeReadyNewSession(spec)
  }
  async pasteText(_name: string, text: string): Promise<void> {
    this.pasteCalls += 1
    this.paneText = `› ${text}\n? for shortcuts`
  }
  async sendText(_name: string, _text: string): Promise<void> {}
  async sendKeys(_name: string, keys: string[]): Promise<void> {
    if (keys.includes('Enter')) this.paneText = '› \nWorking (esc to interrupt)'
  }
  async capturePane(_name: string) {
    return { text: this.paneText }
  }
  async isAlive(_name: string): Promise<boolean> {
    return this.alive
  }
  async getPasteReadiness() { return { state: this.pasteReadiness } }
  async killSession(_name: string): Promise<void> {}
}

describe('CodexWorkerAdapter terminal snapshot after exit', () => {
  it('spawn 后 pane 消失仍读取已有最终画面', async () => {
    class GonePaneTmux extends NoopTmux {
      async capturePane(name: string) {
        if (!this.alive) throw new Error(`tmux session gone: ${name}`)
        return super.capturePane(name)
      }
    }

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-final-terminal-data-'))
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-final-terminal-ws-'))
    const tmux = new GonePaneTmux()
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin: READY_IDLE_BIN, sessionDiscoveryTimeoutMs: 500 })
    try {
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const h = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
      expect(await adapter.readTerminal(h)).toMatchObject({ kind: 'live_terminal' })

      tmux.alive = false
      expect(await adapter.state(h)).toBe('exited')
      await expect(adapter.readTerminal(h)).resolves.toMatchObject({ kind: 'final_terminal', text: expect.stringContaining('Working') })
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
      await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('pane 在读取竞态中变 dead 时返回已有最终画面', async () => {
    class DeadPaneTmux extends NoopTmux {
      dead = false

      async capturePane(name: string) {
        return this.dead
          ? { text: 'Pane is dead (status 1, Tue Aug 19 00:00:00 2026)\n', dead: true }
          : super.capturePane(name)
      }
    }

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dead-pane-terminal-data-'))
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dead-pane-terminal-ws-'))
    const tmux = new DeadPaneTmux()
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin: READY_IDLE_BIN, sessionDiscoveryTimeoutMs: 500 })
    try {
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const h = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
      expect(await adapter.readTerminal(h)).toMatchObject({ kind: 'live_terminal' })

      tmux.dead = true
      await expect(adapter.readTerminal(h)).resolves.toMatchObject({ kind: 'final_terminal', text: expect.stringContaining('Working') })
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
      await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe('CodexWorkerAdapter paste readiness gate', () => {
  it('running steering 在 not_ready 时暂扣输入但保持 running', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-paste-ready-data-'))
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-paste-ready-ws-'))
    const tmux = new NoopTmux()
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin: READY_IDLE_BIN, sessionDiscoveryTimeoutMs: 500 })
    try {
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const h = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })
      await expect(adapter.state(h)).resolves.toBe('running')

      tmux.pasteReadiness = 'not_ready'
      const pasteCalls = tmux.pasteCalls
      await expect(adapter.sendInput(h, '继续')).rejects.toMatchObject({ disposition: 'not_pasted', control_state: 'running' })
      expect(tmux.pasteCalls).toBe(pasteCalls)
      await expect(adapter.state(h)).resolves.toBe('running')
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
      await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe('CodexWorkerAdapter retain-on-exit failure', () => {
  it('持久化 meta 后 retain 失败会收口为 crashed 并清理精确 session', async () => {
    class RetainFailsTmux extends NoopTmux {
      readonly killed: string[] = []
      async newSession(spec: TmuxSessionSpec) {
        return {
          ...await super.newSession(spec),
          enableRemainOnExit: async () => { throw new Error('simulated retain failure') },
        }
      }
      async killSession(name: string): Promise<void> {
        this.killed.push(name)
        this.alive = false
      }
    }

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-retain-failure-data-'))
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-retain-failure-ws-'))
    const tmux = new RetainFailsTmux()
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin: READY_IDLE_BIN, sessionDiscoveryTimeoutMs: 500 })
    try {
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      await expect(adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })).rejects.toThrow('simulated retain failure')
      expect(tmux.killed).toEqual([`crabot-w-${workerId}-1`])
      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
      expect(meta).toMatchObject({ state: 'exited', ended_reason: 'crashed' })
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
      await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})

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
    await writeGeneratedCodexHookConfig(workspaceRoot)
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const h = await adapter.spawn({ worker_id: workerId, prompt: '你好', workspace: { root: workspaceRoot } })

    const { events, nextCursor } = await adapter.readTrace(h)
    expect(events).toEqual([])
    expect(nextCursor).toEqual({ offset: 0 })

    const { events: events2, nextCursor: nextCursor2 } = await adapter.readTrace(h, { offset: 3 })
    expect(events2).toEqual([])
    expect(nextCursor2).toEqual({ offset: 3 })

    await expect(adapter.inspectSupervisionActivity(h, { offset: 3 })).resolves.toEqual({
      kind: 'unknown',
      next_cursor: { offset: 3 },
    })

    await adapter.kill(h)
  })

  it('对本进程内不常驻的 incarnation 调用 readTrace 应拒绝', async () => {
    const tmux = new NoopTmux()
    const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin: 'unused' })
    await expect(adapter.readTrace({ worker_id: 'nope', seq: 1, impl: 'codex' })).rejects.toThrow()
  })

  it(
    '五轮 review PoC①:内容 session_id 与文件名 uuid 分歧、重启后新 adapter 实例——findRolloutFileBySessionId 应退一步按内容匹配到同一文件,readTrace 能读到事件' +
      '(修复前:只按文件名精确匹配,分歧时 rolloutPath 变 undefined,尽管 session_discovery===discovered 且文件明明还在,仍静默返回空数组)',
    async () => {
      const tmux = new NoopTmux()
      const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin: 'unused' })
      const workerId = `codextest-${randomUUID().slice(0, 8)}`

      // 模拟 spawn 时"内容优先"加固已经生效:meta.session_id 落的是内容里的 uuidFromContent,
      // 但 rollout 文件名内嵌的仍是 uuidFromFilename(两者分歧,同 adapter.ts 头注释描述的
      // 竞态/沿用场景)。
      const uuidFromFilename = randomUUID()
      const uuidFromContent = randomUUID()

      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const datePath = path.join(String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
      const sessionsDir = path.join(workspaceRoot, '.codex', 'sessions', datePath)
      await fs.mkdir(sessionsDir, { recursive: true })
      await fs.writeFile(
        path.join(sessionsDir, rolloutFileNameFor(uuidFromFilename)),
        JSON.stringify({ type: 'session_meta', timestamp: '2026-07-30T00:00:00Z', payload: { session_id: uuidFromContent, cli_version: '0.144.1', cwd: workspaceRoot } }) + '\n',
        'utf-8',
      )

      // "重启后重建的 meta":session_discovery: 'discovered',session_id 是内容里的权威值。
      const workerDir = path.join(dataDir, workerId)
      await fs.mkdir(workerDir, { recursive: true })
      await fs.writeFile(
        path.join(workerDir, 'meta-1.json'),
        JSON.stringify({ seq: 1, state: 'idle', session_id: uuidFromContent, session_discovery: 'discovered', workspace_root: workspaceRoot }),
        'utf-8',
      )

      // 新 adapter 实例的 runtimes 为空(模拟重启),ensureRuntime 只能从 meta 重建。
      const { events } = await adapter.readTrace({ worker_id: workerId, seq: 1, impl: 'codex', session_ref: uuidFromContent })
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ kind: 'lifecycle', role: 'system' })
      expect(events[0].summary).toContain(uuidFromContent)
      await adapter.dispose()
    },
  )

  it('把真实结构脱敏 fixture 中的 task_complete failure 投影为 error', async () => {
    const adapter = new CodexWorkerAdapter({ dataDir, tmux: new NoopTmux(), codexBin: 'unused' })
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const sessionId = randomUUID()
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const datePath = path.join(String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
    const sessionsDir = path.join(workspaceRoot, '.codex', 'sessions', datePath)
    await fs.mkdir(sessionsDir, { recursive: true })
    await fs.writeFile(
      path.join(sessionsDir, rolloutFileNameFor(sessionId)),
      await fs.readFile(path.resolve(__dirname, 'fixtures/codex-task-error.jsonl'), 'utf-8'),
      'utf-8',
    )
    const workerDir = path.join(dataDir, workerId)
    await fs.mkdir(workerDir, { recursive: true })
    await fs.writeFile(
      path.join(workerDir, 'meta-1.json'),
      JSON.stringify({ seq: 1, state: 'idle', session_id: sessionId, session_discovery: 'discovered', workspace_root: workspaceRoot }),
      'utf-8',
    )

    const trace = await adapter.readTrace({ worker_id: workerId, seq: 1, impl: 'codex', session_ref: sessionId })
    expect(trace.events).toEqual([expect.objectContaining({
      kind: 'error',
      summary: '[redacted] upstream request failed',
      detail: { message: '[redacted] upstream request failed' },
      source_offset: 0,
    })])
    expect(trace.nextCursor.offset).toBe(1)
    await adapter.dispose()
  })

  it('不把没有结构化 error 的 task_complete 或 error-like 其它事件猜成 error', async () => {
    const adapter = new CodexWorkerAdapter({ dataDir, tmux: new NoopTmux(), codexBin: 'unused' })
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const sessionId = randomUUID()
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const datePath = path.join(String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
    const sessionsDir = path.join(workspaceRoot, '.codex', 'sessions', datePath)
    await fs.mkdir(sessionsDir, { recursive: true })
    await fs.writeFile(path.join(sessionsDir, rolloutFileNameFor(sessionId)), [
      { type: 'event_msg', timestamp: '2026-08-27T00:00:00.000Z', payload: { type: 'task_complete', error: null } },
      { type: 'event_msg', timestamp: '2026-08-27T00:00:01.000Z', payload: { type: 'stream_error', error: { message: 'unknown shape' } } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8')
    const workerDir = path.join(dataDir, workerId)
    await fs.mkdir(workerDir, { recursive: true })
    await fs.writeFile(
      path.join(workerDir, 'meta-1.json'),
      JSON.stringify({ seq: 1, state: 'idle', session_id: sessionId, session_discovery: 'discovered', workspace_root: workspaceRoot }),
      'utf-8',
    )

    const trace = await adapter.readTrace({ worker_id: workerId, seq: 1, impl: 'codex', session_ref: sessionId })
    expect(trace.events.map((event) => event.kind)).toEqual(['lifecycle', 'lifecycle'])
    expect(trace.events.map((event) => event.summary)).toEqual(['task_complete', 'stream_error'])
    await adapter.dispose()
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
      {
        type: 'event_msg',
        timestamp: '2026-07-30T01:00:12Z',
        payload: {
          type: 'item_completed',
          started_at_ms: Date.parse('2026-07-30T01:00:11Z'),
          completed_at_ms: Date.parse('2026-07-30T01:00:12Z'),
          item: {
            type: 'CommandExecution',
            id: 'exec-1',
            command: ['rg', '-n', 'TODO'],
            status: 'failed',
            stdout: '',
            stderr: 'no matches',
            exit_code: 1,
          },
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-07-30T01:00:14Z',
        payload: {
          type: 'item_completed',
          started_at_ms: Date.parse('2026-07-30T01:00:13Z'),
          completed_at_ms: Date.parse('2026-07-30T01:00:14Z'),
          item: {
            type: 'FileChange',
            id: 'exec-2',
            changes: { '/tmp/result.txt': { type: 'add' } },
          },
        },
      },
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
    // 13 行原始数据 + 1 条坏 JSON。两个 item_completed 各展开为同 call_id 的调用/结果，
    // 但 cursor 仍按原始行推进。
    expect(events).toHaveLength(12)
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
    expect(events[8]).toMatchObject({ kind: 'tool_call', role: 'assistant', ts: '2026-07-30T01:00:11.000Z', detail: { call_id: 'exec-1', name: 'exec_command', input: { command: ['rg', '-n', 'TODO'] } } })
    expect(events[9]).toMatchObject({ kind: 'tool_result', ts: '2026-07-30T01:00:12.000Z', detail: { call_id: 'exec-1', output: 'no matches', is_error: true } })
    expect(events[10]).toMatchObject({ kind: 'tool_call', role: 'assistant', ts: '2026-07-30T01:00:13.000Z', detail: { call_id: 'exec-2', name: 'apply_patch', input: { paths: ['/tmp/result.txt'] } } })
    expect(events[11]).toMatchObject({ kind: 'tool_result', ts: '2026-07-30T01:00:14.000Z', detail: { call_id: 'exec-2', output: 'updated 1 file', is_error: false } })
    expect(nextCursor.offset).toBe(14)

    const partial = await adapter.readTrace(h, { offset: 11 })
    expect(partial.events.map((event) => event.detail && (event.detail as { call_id?: string }).call_id)).toEqual(['exec-1', 'exec-1', 'exec-2', 'exec-2'])
    expect(partial.nextCursor.offset).toBe(14)

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

/** 与 cc adapter 同款的接线回归,见 claude-code-adapter.test.ts 同名 describe 的注释。
 * 关键约束:全程不调用 adapter.state()/sendInput(),否则退回 pull 路径就测不出接线。 */
describe('CodexWorkerAdapter — CLI notify 事件文件监视(被动 push)', () => {
  let dataDir: string
  let workspaceRoot: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-watch-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-watch-ws-'))
    await writeGeneratedCodexHookConfig(workspaceRoot)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
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

  it('PermissionRequest reports one current Codex approval screen only once', async () => {

    const seen: Array<{ state: WorkerContractState; report?: StateChangeReport }> = []
    const tmux = new NoopTmux()
    const adapter = new CodexWorkerAdapter({
      dataDir,
      tmux,
      codexBin: 'unused',
      sessionDiscoveryTimeoutMs: 50,
      onStateChange: (_h, state, report) => seen.push({ state, report }),
    })
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const h = await adapter.spawn({ worker_id: workerId, prompt: 'work', workspace: { root: workspaceRoot } })

    tmux.paneText = 'Allow Codex to modify this workspace?\nYes\nNo'
    await fs.appendFile(
      eventsFilePath({ root: workspaceRoot }),
      JSON.stringify({ ts: new Date().toISOString(), kind: 'permission_request', raw: { hook_event_name: 'PermissionRequest' } }) + '\n',
      'utf-8',
    )

    await waitFor(() => seen.length === 1)
    expect(seen).toEqual([{
      state: 'idle',
      report: {
        terminal: { kind: 'live_terminal', text: tmux.paneText, captured_at: expect.any(String) },
        waitReason: 'interaction_required',
        ui: {
          fingerprint: 'codex_approval:yes-no',
          actions: [
            { action_id: 'confirm', kind: 'keys', keys: ['Enter'] },
            { action_id: 'cancel', kind: 'keys', keys: ['Escape'] },
          ],
        },
        notification: { type: 'terminal_interaction' },
      },
    }])

    await fs.appendFile(
      eventsFilePath({ root: workspaceRoot }),
      JSON.stringify({ ts: new Date().toISOString(), kind: 'permission_request', raw: { hook_event_name: 'PermissionRequest' } }) + '\n',
      'utf-8',
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(seen).toHaveLength(1)

    await adapter.respondToUi(h, { kind: 'keys', keys: ['Enter'] })
    expect(await adapter.state(h)).toBe('running')

    tmux.paneText = 'Allow Codex to modify this workspace?\nYes\nNo'
    await fs.appendFile(
      eventsFilePath({ root: workspaceRoot }),
      JSON.stringify({ ts: new Date().toISOString(), kind: 'permission_request', raw: { hook_event_name: 'PermissionRequest' } }) + '\n',
      'utf-8',
    )
    await waitFor(() => seen.length === 2)
    await adapter.kill(h)
  })

  it('UI 回应后的后继交互仍用完整 interaction_required 形状唤醒 Manager', async () => {
    class ChainedPromptTmux extends NoopTmux {
      nextResponse: 'manager_prompt' | 'repainting' | 'pending_input' | undefined

      async sendKeys(name: string, keys: string[]): Promise<void> {
        if (keys.join(',') === 'Enter' && this.nextResponse) {
          const next = this.nextResponse
          this.nextResponse = undefined
          this.paneText = next === 'manager_prompt'
            ? 'Allow Codex to modify this workspace again?\nYes\nNo'
            : next === 'pending_input'
              ? '› retained input\n? for shortcuts'
              : 'terminal is repainting'
          return
        }
        await super.sendKeys(name, keys)
      }
    }

    const seen: Array<{ state: WorkerContractState; report?: StateChangeReport }> = []
    const tmux = new ChainedPromptTmux()
    const adapter = new CodexWorkerAdapter({
      dataDir,
      tmux,
      codexBin: 'unused',
      sessionDiscoveryTimeoutMs: 50,
      onStateChange: (_h, state, report) => seen.push({ state, report }),
    })
    const h = await adapter.spawn({ worker_id: `codextest-${randomUUID().slice(0, 8)}`, prompt: 'work', workspace: { root: workspaceRoot } })
    tmux.paneText = 'Allow Codex to modify this workspace?\nYes\nNo'
    await fs.appendFile(
      eventsFilePath({ root: workspaceRoot }),
      JSON.stringify({ ts: new Date().toISOString(), kind: 'permission_request', raw: { hook_event_name: 'PermissionRequest' } }) + '\n',
      'utf-8',
    )
    await waitFor(() => seen.length === 1)

    tmux.nextResponse = 'manager_prompt'
    await adapter.respondToUi(h, { kind: 'keys', keys: ['Enter'] })
    await waitFor(() => seen.length === 2)

    expect(seen[1]).toEqual({
      state: 'idle',
      report: {
        terminal: { kind: 'live_terminal', text: tmux.paneText, captured_at: expect.any(String) },
        waitReason: 'interaction_required',
        ui: {
          fingerprint: 'codex_approval:yes-no',
          actions: [
            { action_id: 'confirm', kind: 'keys', keys: ['Enter'] },
            { action_id: 'cancel', kind: 'keys', keys: ['Escape'] },
          ],
        },
        notification: { type: 'terminal_interaction' },
      },
    })

    tmux.nextResponse = 'repainting'
    await adapter.respondToUi(h, { kind: 'keys', keys: ['Enter'] })
    await waitFor(() => seen.length === 3)
    expect(seen[2]).toEqual({
      state: 'idle',
      report: {
        terminal: { kind: 'live_terminal', text: tmux.paneText, captured_at: expect.any(String) },
        waitReason: 'interaction_required',
      },
    })

    tmux.paneText = 'Allow Codex to modify this workspace again?\nYes\nNo'
    await fs.appendFile(
      eventsFilePath({ root: workspaceRoot }),
      JSON.stringify({ ts: new Date().toISOString(), kind: 'permission_request', raw: { hook_event_name: 'PermissionRequest' } }) + '\n',
      'utf-8',
    )
    await waitFor(() => seen.length === 4)
    expect(seen[3].report?.notification).toEqual({ type: 'terminal_interaction' })

    tmux.nextResponse = 'pending_input'
    await adapter.respondToUi(h, { kind: 'keys', keys: ['Enter'] })
    await waitFor(() => seen.length === 5)
    expect(seen[4]).toEqual({
      state: 'idle',
      report: {
        terminal: { kind: 'live_terminal', text: tmux.paneText, captured_at: expect.any(String) },
        waitReason: 'input_pending',
      },
    })
    await adapter.kill(h)
  })

  it('spawn 之后 notify 往事件文件追加 stop → 无人调用 state()/sendInput() 也能推出 idle 状态回调', async () => {
    const seen: Array<{ seq: number; state: WorkerContractState }> = []
    const tmux = new NoopTmux()
    const adapter = new CodexWorkerAdapter({
      dataDir,
      tmux,
      codexBin: 'unused',
      sessionDiscoveryTimeoutMs: 50,
      onStateChange: (h, state) => {
        seen.push({ seq: h.seq, state })
      },
    })
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const h = await adapter.spawn({ worker_id: workerId, prompt: '干活', workspace: { root: workspaceRoot } })

    await appendStopEvent()
    await waitFor(() => seen.some((e) => e.state === 'idle'))

    expect(seen.filter((e) => e.state === 'idle')).toHaveLength(1)
    expect(seen[seen.length - 1]).toEqual({ seq: h.seq, state: 'idle' })

    await adapter.kill(h)
  })

  it('waiting_action同时观察到新turn-complete与pane死亡时按完成边界推断，不误记crashed', async () => {
    const tmux = new NoopTmux()
    const adapter = new CodexWorkerAdapter({
      dataDir,
      tmux,
      codexBin: 'unused',
      sessionDiscoveryTimeoutMs: 50,
    })
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const h = await adapter.spawn({ worker_id: workerId, prompt: '干活', workspace: { root: workspaceRoot } })

    await appendStopEvent()
    expect(await adapter.state(h)).toBe('idle')
    tmux.paneText = 'unknown modal surface'
    await expect(adapter.sendInput(h, '暂扣输入')).rejects.toBeTruthy()
    expect(await adapter.state(h)).toBe('idle')

    tmux.alive = false
    await appendStopEvent()
    expect(await adapter.state(h)).toBe('exited')
    const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
    expect(meta.ended_reason).toBe('completed')
  })

  it('waiting_text期间到达的后续stop仍推进基线，不会让下一轮刚开始就被旧stop判回idle', async () => {
    const tmux = new NoopTmux()
    const adapter = new CodexWorkerAdapter({
      dataDir,
      tmux,
      codexBin: 'unused',
      sessionDiscoveryTimeoutMs: 50,
    })
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const h = await adapter.spawn({ worker_id: workerId, prompt: '干活', workspace: { root: workspaceRoot } })

    await appendStopEvent()
    expect(await adapter.state(h)).toBe('idle')
    await appendStopEvent()
    expect(await adapter.state(h)).toBe('idle')

    tmux.paneText = '› \n? for shortcuts'
    await adapter.sendInput(h, '下一轮')
    expect(await adapter.state(h)).toBe('running')

    await adapter.kill(h)
  })

  it('旧状态已是idle但pane仍显示Working时，raw提交仍pending不得误标waiting_action', async () => {
    class PendingWorkingTmux extends NoopTmux {
      async sendKeys(_name: string, keys: string[]): Promise<void> {
        if (keys.includes('Enter')) {
          this.paneText = 'Working (esc to interrupt)\n› 已排队的输入\nqueued message\n? for shortcuts'
        }
      }
    }

    const tmux = new PendingWorkingTmux()
    const adapter = new CodexWorkerAdapter({
      dataDir,
      tmux,
      codexBin: 'unused',
      sessionDiscoveryTimeoutMs: 50,
    })
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const h = await adapter.spawn({ worker_id: workerId, prompt: '干活', workspace: { root: workspaceRoot } })

    tmux.paneText = '› \n? for shortcuts'
    await appendStopEvent()
    expect(await adapter.state(h)).toBe('idle')

    tmux.paneText = 'Working (esc to interrupt)\n› 已排队的输入\n? for shortcuts'
    await expect(adapter.sendInput(h, 'Enter', { raw: true })).rejects.toMatchObject({
      name: 'CliInputStallError',
      disposition: 'pending_in_ui',
      control_state: 'running',
    })
    expect(await adapter.state(h)).toBe('running')

    await adapter.kill(h)
  })

  it('化身落终态后 watcher 停止:kill 之后再追加 stop 事件不再产生任何状态回调', async () => {
    const seen: WorkerContractState[] = []
    const tmux = new NoopTmux()
    const adapter = new CodexWorkerAdapter({
      dataDir,
      tmux,
      codexBin: 'unused',
      sessionDiscoveryTimeoutMs: 50,
      onStateChange: (_h, state) => {
        seen.push(state)
      },
    })
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const h = await adapter.spawn({ worker_id: workerId, prompt: '干活', workspace: { root: workspaceRoot } })

    await adapter.kill(h)
    expect(seen).toEqual(['exited'])

    await appendStopEvent()
    await new Promise((r) => setTimeout(r, 500))
    expect(seen).toEqual(['exited'])
  })

  it('spawn 时 workspace 里已有历史 stop 事件不会被误当作本化身刚完成', async () => {
    await appendStopEvent()

    const seen: WorkerContractState[] = []
    const tmux = new NoopTmux()
    const adapter = new CodexWorkerAdapter({
      dataDir,
      tmux,
      codexBin: 'unused',
      sessionDiscoveryTimeoutMs: 50,
      onStateChange: (_h, state) => {
        seen.push(state)
      },
    })
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const h = await adapter.spawn({ worker_id: workerId, prompt: '干活', workspace: { root: workspaceRoot } })

    await new Promise((r) => setTimeout(r, 500))
    expect(seen).toEqual([])

    await appendStopEvent()
    await waitFor(() => seen.includes('idle'))
    expect(seen).toEqual(['idle'])

    await adapter.kill(h)
  })
})

/** 与 cc adapter 同款的并发重建回归,见 claude-code-adapter.test.ts 同名 describe 的注释。 */
describe('CodexWorkerAdapter.ensureRuntime — 并发重建不泄漏 watcher', () => {
  let dataDir: string
  let workspaceRoot: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-concurrent-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-concurrent-ws-'))
    await fs.mkdir(path.join(workspaceRoot, '.codex'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('并发首次触达同一化身:每个 stop 事件只唤醒一次,化身退出后也没有残留 watcher 继续推', async () => {
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const sessionId = randomUUID()
    await fs.mkdir(path.join(dataDir, workerId), { recursive: true })
    await fs.writeFile(
      path.join(dataDir, workerId, 'meta-1.json'),
      JSON.stringify({ seq: 1, state: 'running', session_id: sessionId, workspace_root: workspaceRoot, session_discovery: 'placeholder' }),
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
    const adapter = new CodexWorkerAdapter({
      dataDir,
      tmux,
      codexBin: 'unused',
      sessionDiscoveryTimeoutMs: 50,
      onStateChange: (_h, state) => {
        seen.push(state)
      },
    })
    const h: IncarnationHandle = { worker_id: workerId, seq: 1, impl: 'codex', session_ref: sessionId }

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

    await appendStop()
    await waitFor(() => seen.length > 0)
    await new Promise((r) => setTimeout(r, 500))
    expect(seen).toEqual(['idle'])

    tmux.alive = false
    await appendStop()
    await waitFor(() => seen.includes('exited'))
    await new Promise((r) => setTimeout(r, 500))
    expect(seen).toEqual(['idle', 'exited'])
  }, 15000)

  it('dispose 释放现有 watcher，之后 runtime 重建也不会重新装 watcher 或杀 tmux', async () => {
    const workerId = `codextest-${randomUUID().slice(0, 8)}`
    const sessionId = randomUUID()
    const workerDir = path.join(dataDir, workerId)
    await fs.mkdir(workerDir, { recursive: true })
    for (const seq of [1, 2]) {
      await fs.writeFile(
        path.join(workerDir, `meta-${seq}.json`),
        JSON.stringify({ seq, state: 'running', session_id: sessionId, workspace_root: workspaceRoot, session_discovery: 'placeholder' }),
        'utf-8',
      )
    }

    const tmux = new NoopTmux()
    const stop = vi.fn(async () => {})
    const watch = vi.spyOn(CliEventChannel.prototype, 'watch').mockReturnValue(stop)
    const killSession = vi.spyOn(tmux, 'killSession')
    const adapter = new CodexWorkerAdapter({ dataDir, tmux, codexBin: 'unused' })

    await adapter.state({ worker_id: workerId, seq: 1, impl: 'codex', session_ref: sessionId })
    await Promise.all([adapter.dispose(), adapter.dispose()])
    await adapter.state({ worker_id: workerId, seq: 2, impl: 'codex', session_ref: sessionId })

    expect(watch).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(killSession).not.toHaveBeenCalled()
  })
})

/**
 * 启动期就绪握手(spec: 2026-08-04-cli-worker-readiness-design)—— 与 cc adapter 对称的一套。
 *
 * codex 结构上得的是同一个病:发 prompt 走的是同一个 `TmuxDriver.sendText`,
 * `paste-buffer -p` 同样只在目标程序已请求 bracketed paste 时才包裹。生产上它只是侥幸
 * (m2 实测 codex 在 byte 0 就发 `\e[?2004h`,且 rollout 轮询恰好挡了约 3 秒),而那两个
 * 偶然因素在最需要它们的失败路径上会同时失效——被模态框挡住时会话不建立、rollout 不落盘,
 * 轮询空转到超时后**照样发 prompt**,还把 session_ref 降级成占位 uuid。
 */
describe.skipIf(!tmuxAvailable)('CodexWorkerAdapter — 启动期就绪握手(\\e[?2004h)', () => {
  /** 记录 sendText 调用,其余行为完全走真实 TmuxDriver。 */
  class SpyTmux extends TmuxDriver {
    readonly pasteTextCalls: Array<{ name: string; text: string }> = []
    async pasteText(name: string, text: string): Promise<void> {
      this.pasteTextCalls.push({ name, text })
      return super.pasteText(name, text)
    }
  }

  let dataDir: string
  let workspaceRoot: string
  let stdinLog: string
  let tmux: SpyTmux

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-ready-data-'))
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-ready-ws-'))
    stdinLog = path.join(dataDir, 'stdin.log')
    tmux = new SpyTmux()
  })

  afterEach(async () => {
    await cleanupTmuxSessions()
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  async function submissions(): Promise<string[]> {
    const raw = await fs.readFile(stdinLog, 'utf-8').catch(() => '')
    return raw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as string)
  }

  async function makeAdapter(opts: { readyDelayMs?: number; banner?: string; pasteReadyTimeoutMs?: number }) {
    const channel = new CliEventChannel(eventsFilePath({ root: workspaceRoot }))
    const codexHome = path.join(workspaceRoot, '.codex')
    const rolloutUuid = randomUUID()
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const datePath = path.join(String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
    const rolloutFile = path.join(codexHome, 'sessions', datePath, rolloutFileNameFor(rolloutUuid))

    const envParts = [
      `MOCK_CLI_SCRIPT=${shQuote('[]')}`,
      `MOCK_CLI_STOP_HOOK_CMD=${shQuote(channel.hookCommand('stop'))}`,
      `MOCK_CLI_STDIN_LOG=${shQuote(stdinLog)}`,
      `MOCK_CLI_ROLLOUT_FILE=${shQuote(rolloutFile)}`,
    ]
    if (opts.readyDelayMs) envParts.push(`MOCK_CLI_PASTE_READY_DELAY_MS=${opts.readyDelayMs}`)
    if (opts.banner) envParts.push(`MOCK_CLI_BANNER=${shQuote(opts.banner)}`)

    const seen: Array<{ state: WorkerContractState; report?: StateChangeReport }> = []
    const adapter = new CodexWorkerAdapter({
      dataDir,
      tmux,
      codexBin: `env ${envParts.join(' ')} node ${shQuote(MOCK_CLI)}`,
      sessionDiscoveryTimeoutMs: 1500,
      pasteReadyTimeoutMs: opts.pasteReadyTimeoutMs,
      onStateChange: (_h, state, report) => seen.push({ state, report }),
    })
    await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
    return { adapter, seen, rolloutUuid, workerId: `codextest-${randomUUID().slice(0, 8)}` }
  }

  const MULTILINE_PROMPT = ['任务:核对上游依赖', '背景:昨天的构建挂了', '验收:给出修复方案'].join('\n')

  it(
    'TUI 迟迟不开 bracketed paste 时,prompt 不被拆成按键——握手等到之后整段一次提交',
    async () => {
      const { adapter, workerId } = await makeAdapter({ readyDelayMs: 1200 })
      await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })

      const deadline = Date.now() + 5000
      while (Date.now() < deadline && (await submissions()).length === 0) {
        await new Promise((r) => setTimeout(r, 50))
      }

      expect(await submissions()).toEqual([MULTILINE_PROMPT])
      expect(tmux.pasteTextCalls).toHaveLength(1)
    },
    30000,
  )

  it(
    '就绪立刻到位时:session 发现照常拿到真实 id,时序不回归',
    async () => {
      const { adapter, rolloutUuid, workerId } = await makeAdapter({})
      const startedAt = Date.now()
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })
      expect(Date.now() - startedAt).toBeLessThan(10_000)
      expect(h.session_ref).toBe(rolloutUuid)

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
      await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })

      expect(tmux.pasteTextCalls).toEqual([])
      await new Promise((r) => setTimeout(r, 500))
      expect(tmux.pasteTextCalls).toEqual([])
      expect(await submissions()).toEqual([])
    },
    30000,
  )

  it(
    '等不到就绪 → 落 idle,并把 output 尾部随状态回调交给 manager(不 kill 现场)',
    async () => {
      const banner = 'Sign in with ChatGPT / Provide your own API key'
      const { adapter, seen, workerId } = await makeAdapter({
        readyDelayMs: 600_000,
        pasteReadyTimeoutMs: 2000,
        banner,
      })
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })

      const stalled = h.initial_input
      expect(stalled).toMatchObject({
        control_state: 'waiting_action',
        disposition: 'not_pasted',
        report: { waitReason: 'startup_stall' },
      })
      expect(stalled?.report?.terminal).toMatchObject({ kind: 'live_terminal', text: expect.stringContaining(banner) })
      expect(seen).toEqual([])

      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
      expect(meta.state).toBe('idle')
      expect(await adapter.state(h)).not.toBe('exited')
    },
    30000,
  )

  it(
    '等待期间进程自己死了 → 落 exited(crashed),不谎报 idle、更不能记成 completed',
    async () => {
      // 六轮 review,与 cc adapter 的同名用例同款:syncState 缺省推断是"非 kill ⇒ completed"
      // (§6.3 给"干过活之后自然退出"校准的),但这条路径上开工输入一个字符都没投递过——吃下
      // 缺省就会让 harness 把 task 记成 **completed**,manager 与 recovery 从此不再过问它
      // (正是 #66 修的那类"失败记成成功")。把 initialStartupStall 里的 'crashed' 改回缺省,
      // 这条用例就挂。
      const seen: Array<{ state: WorkerContractState; endReason?: string }> = []
      const adapter = new CodexWorkerAdapter({
        dataDir,
        tmux,
        // 启动即失败:pane 里的命令立刻退出,永远不会有就绪信号。
        codexBin: `bash -c 'exit 1'`,
        sessionDiscoveryTimeoutMs: 200,
        pasteReadyTimeoutMs: 30_000, // 靠 isAlive 提前收工,不该等满
        onStateChange: (_h, state, report) => void seen.push({ state, endReason: report?.endReason }),
      })
      await adapter.provision({ root: workspaceRoot }, { skills: [], mcp_servers: [] })
      const workerId = `codextest-${randomUUID().slice(0, 8)}`

      const startedAt = Date.now()
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })
      expect(Date.now() - startedAt).toBeLessThan(15_000)

      expect(tmux.pasteTextCalls).toEqual([])
      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
      expect(meta.state).toBe('exited')
      expect(meta.ended_reason).toBe('crashed')
      expect(await adapter.state(h)).toBe('exited')
      expect(h.initial_input).toMatchObject({
        control_state: 'exited',
        disposition: 'not_pasted',
        report: { endReason: 'crashed' },
      })
      expect(seen).toEqual([])
    },
    40000,
  )

  it(
    '这条 idle 粘得住:再调 state() 不会被三源判定翻回 running(pane 活着 + turn-complete 计数恒不涨)',
    async () => {
      // 与 cc adapter 的同名用例同款(五轮 review):去掉 syncState 里维持 waiting_action 的
      // 那一支,computed 恒为 running,刚落的 idle 连同台账一起被翻回"正在干活"。
      const { adapter, workerId } = await makeAdapter({ readyDelayMs: 600_000, pasteReadyTimeoutMs: 2000 })
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })

      expect(await adapter.state(h)).toBe('idle')
      expect(await adapter.state(h)).toBe('idle')
      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
      expect(meta.state).toBe('idle')
      expect(meta.wait_mode).toBe('action')
      expect(meta.wait_reason).toBe('startup_stall')
      expect(meta.startup_stalled).toBeUndefined()
    },
    30000,
  )

  it(
    'agent 重启后仍然是 idle:暂扣态跟着 meta 落盘,reconcileOnStartup 的 state() 不会把台账拉回 running',
    async () => {
      const { adapter, workerId } = await makeAdapter({ readyDelayMs: 600_000, pasteReadyTimeoutMs: 2000 })
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })
      expect(await adapter.state(h)).toBe('idle')

      const restarted = new CodexWorkerAdapter({ dataDir, tmux, codexBin: 'never-used-after-restart' })
      expect(await restarted.state(h)).toBe('idle')
    },
    30000,
  )

  it(
    '暂扣态置位之后进程才死 → 落 exited(crashed),不吃"非 kill ⇒ completed"的缺省推断',
    async () => {
      // 与 cc adapter 的同名用例同款(七轮 review):deadReason 形参只管住"握手等待期间就死了"
      // 那一个时点,而暂扣是持续状态——idle 落定之后才死的化身,后续任何一次 syncState 判到
      // exited 仍会吃缺省推断,把没投递过一个字符的 worker 记成"成功完成"。去掉 syncState
      // exited 分支里的 waiting_action 判断,这条用例就挂。
      const { adapter, seen, workerId } = await makeAdapter({ readyDelayMs: 600_000, pasteReadyTimeoutMs: 2000 })
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })
      expect(await adapter.state(h)).toBe('idle')

      // 外部收走 pane:不是本进程发起的 kill(runtime.killed 仍为 false),所以走推断分支。
      execFileSync('tmux', ['kill-session', '-t', `crabot-w-${workerId}-1`], { stdio: 'ignore' })

      expect(await adapter.state(h)).toBe('exited')
      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
      expect(meta.ended_reason).toBe('crashed')
      expect(seen.filter((s) => s.state === 'exited').map((s) => s.report?.endReason)).toEqual(['crashed'])
    },
    30000,
  )

  it(
    'agent 重启之后才发现死亡(reconcileOnStartup 形态)→ 仍是 crashed:暂扣标志从 meta 复原',
    async () => {
      // 与 cc adapter 的同名用例同款:重启后新 adapter 实例的 runtimes 必为空,暂扣态只能靠
      // 落盘的 startup_stalled 复原,然后 reconcileOnStartup 的 state() 才判到 exited。
      const { adapter, workerId } = await makeAdapter({ readyDelayMs: 600_000, pasteReadyTimeoutMs: 2000 })
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })
      expect(await adapter.state(h)).toBe('idle')

      const seen: Array<{ state: WorkerContractState; endReason?: string }> = []
      const restarted = new CodexWorkerAdapter({
        dataDir,
        tmux,
        codexBin: 'never-used-after-restart',
        onStateChange: (_h, state, report) => void seen.push({ state, endReason: report?.endReason }),
      })
      expect(await restarted.state(h)).toBe('idle') // 重连接管,标志复原

      execFileSync('tmux', ['kill-session', '-t', `crabot-w-${workerId}-1`], { stdio: 'ignore' })

      expect(await restarted.state(h)).toBe('exited')
      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
      expect(meta.ended_reason).toBe('crashed')
      expect(seen).toContainEqual({ state: 'exited', endReason: 'crashed' })
    },
    30000,
  )

  it(
    'manager显式raw Enter后出现active证据，随后进程死亡按completed推断',
    async () => {
      const { adapter, seen, workerId } = await makeAdapter({ readyDelayMs: 600_000, pasteReadyTimeoutMs: 2000 })
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })
      expect(await adapter.state(h)).toBe('idle')

      await expect(adapter.sendInput(h, 'Enter', { raw: true })).resolves.toBeUndefined()
      expect(await adapter.state(h)).toBe('running')

      execFileSync('tmux', ['kill-session', '-t', `crabot-w-${workerId}-1`], { stdio: 'ignore' })

      expect(await adapter.state(h)).toBe('exited')
      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
      expect(meta.ended_reason).toBe('completed')
      expect(seen.filter((s) => s.state === 'exited').map((s) => s.report?.endReason)).toEqual(['completed'])
    },
    30000,
  )

  it(
    'startup stall上的raw只发指定键；出现active证据后转running',
    async () => {
      const { adapter, workerId } = await makeAdapter({ readyDelayMs: 600_000, pasteReadyTimeoutMs: 2000 })
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })
      expect(await adapter.state(h)).toBe('idle')

      const sendKeys = vi.spyOn(tmux, 'sendKeys')
      try {
        await expect(adapter.sendInput(h, 'y208地形已完成', { raw: true })).rejects.toMatchObject({
          name: 'InvalidRawControlInputError',
          certainty: 'not_delivered',
        })
        expect(sendKeys).not.toHaveBeenCalled()

        await expect(adapter.sendInput(h, 'Enter', { raw: true })).resolves.toBeUndefined()
        expect(await adapter.state(h)).toBe('running')
        const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
        expect(meta.state).toBe('running')
        expect(meta.wait_mode).toBeUndefined()
      } finally {
        sendKeys.mockRestore()
      }
    },
    30000,
  )

  it(
    'raw键未送达前pane退出时仍抛WorkerExitedError，保留透明接续信号',
    async () => {
      const { adapter, workerId } = await makeAdapter({ readyDelayMs: 600_000, pasteReadyTimeoutMs: 2000 })
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })
      const sendKeys = vi.spyOn(tmux, 'sendKeys').mockImplementation(async (name) => {
        await tmux.killSession(name)
        throw new Error('pane exited before keys were sent')
      })

      try {
        await expect(adapter.sendInput(h, 'C-d', { raw: true })).rejects.toMatchObject({
          name: 'WorkerExitedError',
          ended_reason: 'crashed',
        })
      } finally {
        sendKeys.mockRestore()
      }
    },
    30000,
  )

  it(
    'raw键已送达且导致pane退出时正常结算，不把键名当未投递正文透明接续',
    async () => {
      const { adapter, workerId } = await makeAdapter({ readyDelayMs: 600_000, pasteReadyTimeoutMs: 2000 })
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })
      const originalSendKeys = tmux.sendKeys.bind(tmux)
      const sendKeys = vi.spyOn(tmux, 'sendKeys').mockImplementation(async (name, keys) => {
        await originalSendKeys(name, keys)
        await tmux.killSession(name)
      })

      try {
        await expect(adapter.sendInput(h, 'C-d', { raw: true })).resolves.toBeUndefined()
        expect(await adapter.state(h)).toBe('exited')
        const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
        expect(meta.ended_reason).toBe('completed')
      } finally {
        sendKeys.mockRestore()
      }
    },
    30000,
  )

  it(
    '启动暂扣给 manager 的是直接捕获的可读终端画面，不含转义序列',
    async () => {
      // 与 cc adapter 的同名用例同款：报告必须来自 capture-pane 的当前画面，而不是原始
      // TUI 渲染字节。
      const banner = [
        '\u001b[2J\u001b[H',
        '\u001b[3;1H\u001b[1;36mSign in with ChatGPT\u001b[0m',
        '\u001b[4;1H  1. Provide your own API key',
      ].join('')
      const { adapter, seen, workerId } = await makeAdapter({
        readyDelayMs: 600_000,
        pasteReadyTimeoutMs: 2000,
        banner,
      })
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })

      const terminal = h.initial_input?.report?.terminal
      expect(terminal).toMatchObject({ kind: 'live_terminal' })
      const text = terminal?.kind === 'unavailable' || !terminal ? '' : terminal.text
      expect(text).not.toContain('\u001b')
      expect(text).toMatch(/Sign in with ChatGPT\n\s*1\. Provide your own API key/)
    },
    30000,
  )

  it(
    '超时路径下 session_ref 不降级成占位 uuid —— 会话根本没建立,给个像真的假 id 只会让 resume/readTrace 静默失效',
    async () => {
      const { adapter, workerId } = await makeAdapter({ readyDelayMs: 600_000, pasteReadyTimeoutMs: 2000 })
      const h = await adapter.spawn({ worker_id: workerId, prompt: MULTILINE_PROMPT, workspace: { root: workspaceRoot } })

      expect(h.session_ref).toBe('')
      expect(h.session_ref).not.toMatch(/^[0-9a-f]{8}-/)
      const meta = JSON.parse(await fs.readFile(path.join(dataDir, workerId, 'meta-1.json'), 'utf-8'))
      expect(meta.session_id).toBe('')

      // resume 对着"没有会话"的化身必须给出说得清的错误,而不是一句看不懂的 UUID 格式错。
      await expect(adapter.resume({ worker_id: workerId, seq: 1, session_ref: '' }, '继续')).rejects.toThrow(
        /has no codex session/,
      )
    },
    30000,
  )
})
