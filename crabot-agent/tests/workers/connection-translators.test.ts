import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findTranslator, connectionCapabilitiesFor } from '../../src/workers/connections/registry.js'
import { buildScrubbedChildEnv } from '../../src/workers/connections/secret-env.js'
import { RuntimeFileSet } from '../../src/workers/connections/runtime-file.js'
import { expectPrivateRuntimeFile } from './private-runtime-file.js'

async function binaryFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-binary-resolution-')))
  const home = path.join(root, 'home'), data = path.join(root, 'data'), globalDir = path.join(root, 'global'), userDir = path.join(home, 'bin')
  for (const directory of [data, globalDir, userDir]) await fs.mkdir(directory, { recursive: true })
  for (const directory of [globalDir, userDir]) await fs.writeFile(path.join(directory, 'crabot-fake-cli'), '#!/bin/sh\necho ok\n', { mode: 0o755 })
  return { root, home, data, globalDir, userDir }
}

describe('connection translators（P6-B §7）', () => {
  it('translator 不以 CLI 版本筛选 connection mode', () => {
    expect(findTranslator('codex', 'existing_host')).toBeDefined()
    expect(connectionCapabilitiesFor('codex').map((cap) => cap.mode).sort()).toEqual(['admin_provider', 'existing_host', 'native_account'])
  })

  it('claude admin_provider：endpoint/key/model 落到 ANTHROPIC_* env；非 anthropic format 拒绝', () => {
    const translator = findTranslator('claude-code', 'admin_provider')!
    expect(translator.capability.translator_id).toBe('claude-code-anthropic-runtime-v1')
    const injection = translator.buildInjection({
      connection: { endpoint: 'https://api.example', apikey: 'sk-test', model_id: 'claude-x', format: 'anthropic' },
    })
    expect(injection.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.example',
      ANTHROPIC_AUTH_TOKEN: 'sk-test',
      ANTHROPIC_MODEL: 'claude-x',
    })
    expect(() => translator.buildInjection({
      connection: { endpoint: 'https://api.example', apikey: 'sk', model_id: 'm', format: 'openai' },
    })).toThrow(/format/)
  })

  it('codex admin_provider：config.toml wire_api=responses + env_key 引用，credential 不落正文', () => {
    const translator = findTranslator('codex', 'admin_provider')!
    const injection = translator.buildInjection({
      connection: { endpoint: 'https://api.example', apikey: 'sk-secret', model_id: 'gpt-x', format: 'openai-responses' },
    })
    expect(injection.runtimeFiles?.['config.toml']).toContain('wire_api = "responses"')
    expect(injection.runtimeFiles?.['config.toml']).toContain('env_key')
    expect(injection.runtimeFiles?.['config.toml']).not.toContain('sk-secret')
    expect(injection.env['CRABOT_WORKER_ADMIN_PROVIDER_KEY']).toBe('sk-secret')
    // 普通 openai format 不因名字相近自动兼容
    expect(() => translator.buildInjection({
      connection: { endpoint: 'https://e', apikey: 'k', model_id: 'm', format: 'openai' },
    })).toThrow(/format/)
  })

  it('native/existing_host translator：零注入，capabilities 不按版本过滤', () => {
    expect(findTranslator('claude-code', 'existing_host')!.buildInjection({}).env).toEqual({})
    expect(findTranslator('codex', 'native_account')).toBeDefined()
    const caps = connectionCapabilitiesFor('claude-code')
    expect(caps.map((c) => c.mode).sort()).toEqual(['admin_provider', 'existing_host', 'native_account'])
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
    if (process.platform === 'win32') {
      await fs.rmdir(root)
      require('../../../scripts/lib/process-identity.cjs').createPrivateDirectory(root)
    }
    const set = await RuntimeFileSet.create(root, { 'config.toml': 'x = 1' })
    await expectPrivateRuntimeFile(set.resolve('config.toml'), root)
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
    expect(source).toMatch(/async fork\(prev: IncarnationRef, forkInput: string, opts: ForkOptions\)/)
    expect(source).toMatch(/opts\.connection_env \?\? prevRuntime\.connectionEnv/)
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
    const f = await binaryFixture()
    try {
      const result = await resolveUserLevelBinary('crabot-fake-cli', f.data, { homeDir: f.home, pathEnv: f.globalDir })
      expect(result.binary).toBeUndefined()
      expect(result.global_detected).toBe(true)
    } finally { await fs.rm(f.root, { recursive: true, force: true }) }
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
    const f = await binaryFixture()
    const { resolveUserLevelBinary } = await import('../../src/workers/cli-binary.js')
    try {
      const result = await resolveUserLevelBinary('crabot-fake-cli', f.data, { homeDir: f.home, pathEnv: [f.globalDir, f.userDir].join(path.delimiter) })
      expect(result.binary).toBe(path.join(f.userDir, 'crabot-fake-cli'))
      expect(result.global_detected).toBe(false)
    } finally {
      await fs.rm(f.root, { recursive: true, force: true })
    }
  })
})
