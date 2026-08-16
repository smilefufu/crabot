import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findTranslator, connectionCapabilitiesFor, versionInRange } from '../../src/workers/connections/registry.js'
import { buildScrubbedChildEnv } from '../../src/workers/connections/secret-env.js'
import { RuntimeFileSet } from '../../src/workers/connections/runtime-file.js'

describe('connection translators（P6-B §7）', () => {
  it('版本 range 匹配：2.x / 0.146.x / 超 range 拒绝', () => {
    expect(versionInRange('2.1.227', '2.x')).toBe(true)
    expect(versionInRange('3.0.0', '2.x')).toBe(false)
    expect(versionInRange('0.146.0', '0.146.x')).toBe(true)
    expect(versionInRange('0.147.0', '0.146.x')).toBe(false)
    expect(versionInRange('garbage', '2.x')).toBe(false)
  })

  it('claude admin_provider：endpoint/key/model 落到 ANTHROPIC_* env；非 anthropic format 拒绝', () => {
    const translator = findTranslator('claude-code', 'admin_provider', '2.1.227')!
    expect(translator.capability.translator_id).toBe('claude-code-anthropic-runtime-v1')
    const injection = translator.buildInjection({
      cli_version: '2.1.227',
      connection: { endpoint: 'https://api.example', apikey: 'sk-test', model_id: 'claude-x', format: 'anthropic' },
    })
    expect(injection.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.example',
      ANTHROPIC_AUTH_TOKEN: 'sk-test',
      ANTHROPIC_MODEL: 'claude-x',
    })
    expect(() => translator.buildInjection({
      cli_version: '2.1.227',
      connection: { endpoint: 'https://api.example', apikey: 'sk', model_id: 'm', format: 'openai' },
    })).toThrow(/format/)
  })

  it('codex admin_provider：config.toml wire_api=responses + env_key 引用，credential 不落正文', () => {
    const translator = findTranslator('codex', 'admin_provider', '0.146.0')!
    const injection = translator.buildInjection({
      cli_version: '0.146.0',
      connection: { endpoint: 'https://api.example', apikey: 'sk-secret', model_id: 'gpt-x', format: 'openai-responses' },
    })
    expect(injection.runtimeFiles?.['config.toml']).toContain('wire_api = "responses"')
    expect(injection.runtimeFiles?.['config.toml']).toContain('env_key')
    expect(injection.runtimeFiles?.['config.toml']).not.toContain('sk-secret')
    expect(injection.env['CRABOT_WORKER_ADMIN_PROVIDER_KEY']).toBe('sk-secret')
    // 普通 openai format 不因名字相近自动兼容
    expect(() => translator.buildInjection({
      cli_version: '0.146.0',
      connection: { endpoint: 'https://e', apikey: 'k', model_id: 'm', format: 'openai' },
    })).toThrow(/format/)
  })

  it('native/existing_host translator：零注入；超 range CLI 找不到 translator', () => {
    expect(findTranslator('claude-code', 'existing_host', '2.1.227')!.buildInjection({ cli_version: '2.1.227' }).env).toEqual({})
    expect(findTranslator('codex', 'native_account', '0.146.0')).toBeDefined()
    expect(findTranslator('codex', 'native_account', '0.100.0')).toBeUndefined()
    // capabilities 列表按版本过滤
    const caps = connectionCapabilitiesFor('claude-code', '2.1.227')
    expect(caps.map((c) => c.mode).sort()).toEqual(['admin_provider', 'existing_host', 'native_account'])
    expect(connectionCapabilitiesFor('claude-code', '9.9.9')).toEqual([])
  })

  it('child env scrub：bearer/provider/CLI credential 一律不继承，proxy/PATH 保留', () => {
    const env = buildScrubbedChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      CRABOT_CORE_AGENT_RUNTIME_BEARER: 'bearer-secret',
      ANTHROPIC_API_KEY: 'sk-leak',
      OPENAI_API_KEY: 'sk-leak2',
      CODEX_HOME: '/home/x/.codex',
      RANDOM_UNRELATED: 'nope',
    } as NodeJS.ProcessEnv)
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.CRABOT_CORE_AGENT_RUNTIME_BEARER).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CODEX_HOME).toBeUndefined()
    expect(env.RANDOM_UNRELATED).toBeUndefined()
  })

  it('runtime file：0600 落盘、逃逸拒绝、dispose 清空', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-runtime-file-'))
    const set = await RuntimeFileSet.create(root, { 'config.toml': 'x = 1' })
    const stat = await fs.stat(set.resolve('config.toml'))
    expect(stat.mode & 0o777).toBe(0o600)
    expect(() => set.resolve('../escape')).toThrow(/escapes/)
    await set.dispose()
    await expect(fs.stat(set.root)).rejects.toThrow(/ENOENT/)
    await fs.rm(root, { recursive: true, force: true })
  })
})

describe('fork connection_env 透传（R10 回归钉死）', () => {
  it('claude adapter fork 接收并使用 opts.connection_env（不被静默丢弃）', async () => {
    // 直接读源码断言签名与消费——TS 允许实现少收形参无告警，这条钉死「接口扩了实现没跟上」。
    const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../../src/workers/claude-code/adapter.ts', import.meta.url), 'utf-8'))
    expect(source).toMatch(/async fork\(prev: IncarnationRef, forkInput: string, opts\?: \{ connection_env\?: Record<string, string> \}\)/)
    expect(source).toMatch(/opts\?\.connection_env \?\? prevRuntime\.connectionEnv/)
  })
})

describe('用户级 binary 路径含空格（R15 实证 + 移除 managed 后语义更新）', () => {
  it('detect 对空格路径加引号，真实可执行；install_source=user', async () => {
    const spacedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot space dir '))
    const bin = path.join(spacedDir, 'fake-cli')
    await fs.writeFile(bin, '#!/bin/sh\necho "9.9.9 (Fake CLI)"\n', { mode: 0o755 })
    const { ClaudeCodeAdapter } = await import('../../src/workers/claude-code/adapter.js')
    const adapter = new ClaudeCodeAdapter({
      dataDir: spacedDir,
      resolveUserLevelBinary: async () => ({ binary: bin, global_detected: false }),
    })
    const result = await adapter.detect()
    expect(result.installed).toBe(true)
    expect(result.version).toBe('9.9.9')
    expect(result.install_source).toBe('user')
    await fs.rm(spacedDir, { recursive: true, force: true })
  })

  it('resolveUserLevelBinary：全局路径（$HOME 之外）被忽略并报 global_detected', async () => {
    const { resolveUserLevelBinary } = await import('../../src/workers/cli-binary.js')
    // 'sh' 在 /bin/sh（全局）——必被忽略
    const result = await resolveUserLevelBinary('sh', '/tmp/crabot-data')
    expect(result.binary).toBeUndefined()
    expect(result.global_detected).toBe(true)
  })
})

describe('用户级-only 不变量（PR95 review）', () => {
  it('resolver 明确返回无用户级时：detect installed=false + global hint；spawn fail-loud 不回落裸命令', async () => {
    const { ClaudeCodeAdapter } = await import('../../src/workers/claude-code/adapter.js')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-nobin-'))
    const adapter = new ClaudeCodeAdapter({
      dataDir: dir,
      resolveUserLevelBinary: async () => ({ global_detected: true }),
    })
    const detected = await adapter.detect()
    expect(detected.installed).toBe(false)
    expect(detected.global_detected).toBe(true)
    await expect(adapter.spawn({
      worker_id: 'w-nobin-test', prompt: 'x', workspace: { root: dir },
    })).rejects.toThrow(/user-level/)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('resolveUserLevelBinary：PATH 前面是全局、后面是用户级时选中用户级', async () => {
    const home = os.homedir()
    const userBinDir = path.join(home, '.crabot-test-bin')
    await fs.mkdir(userBinDir, { recursive: true })
    const userBin = path.join(userBinDir, 'crabot-fake-cli')
    await fs.writeFile(userBin, '#!/bin/sh\necho ok\n', { mode: 0o755 })
    const { resolveUserLevelBinary } = await import('../../src/workers/cli-binary.js')
    const origPath = process.env.PATH
    process.env.PATH = `/usr/bin:${userBinDir}:${origPath}`
    try {
      const result = await resolveUserLevelBinary('crabot-fake-cli', '/tmp/crabot-data')
      expect(result.binary).toBe(userBin)
      expect(result.global_detected).toBe(false)
    } finally {
      process.env.PATH = origPath
      await fs.rm(userBinDir, { recursive: true, force: true })
    }
  })
})
