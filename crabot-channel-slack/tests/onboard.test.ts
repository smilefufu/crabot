import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ProxyManager } from 'crabot-shared'
import { SlackOnboarder } from '../src/onboard.js'
import { SLACK_MANIFEST } from '../src/cli-project.js'
import { cliEnvironment, ensureCli, type CliJob } from '../src/cli-tools.js'
const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function setup(options: { fail?: boolean; waitMs?: number; configureMs?: number; stopFails?: boolean } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-onboard-test-')); roots.push(dataDir)
  const commands: string[][] = [], stopped: boolean[] = []
  const preexistingApps: Array<string | undefined> = []
  const proxyContexts: unknown[] = []
  const launch = (_executable: string, args: string[], project: string, proxy?: unknown): CliJob => {
    commands.push(args); proxyContexts.push(proxy)
    if (args[0] === 'run') {
      let resolve!: (value: { code: number; output: string }) => void
      const result = new Promise<{ code: number; output: string }>(r => { resolve = r })
      void (async () => {
        try { preexistingApps.push(JSON.parse(await fs.readFile(path.join(project, '.slack/apps.dev.json'), 'utf8')).TTEST?.app_id) } catch { preexistingApps.push(undefined) }
        await fs.writeFile(path.join(project, '.slack/apps.dev.json'), JSON.stringify({ TTEST: { app_id: 'ATEST' } }))
        if (!options.fail) await fs.writeFile(path.join(project, '../handoff.json'), JSON.stringify({ bot_token: 'xoxb-fixture', app_token: 'xapp-fixture' }), { mode: 0o600 })
      })()
      return { result, async stop() { if (options.stopFails) throw new Error('raw xoxb-SECRET'); stopped.push(true); resolve({ code: 130, output: '' }) } }
    }
    const result = (async () => {
      if (args.includes('--challenge')) {
        await fs.writeFile(args[args.indexOf('--config-dir') + 1] + '/credentials.json', JSON.stringify({ TTEST: { team_id: 'TTEST', user_id: 'UTEST' } }), { mode: 0o600 })
        return { code: 0, output: '' }
      }
      return { code: 0, output: '/slackauthticket fixture-ticket' }
    })()
    return { result, async stop() { stopped.push(true) } }
  }
  const verify = vi.fn(async () => {})
  const onboarder = new SlackOnboarder({ dataDir, ensureCli: async () => '/fixed/official-cli', startCli: launch, verify, ...options })
  return { onboarder, dataDir, commands, stopped, verify, preexistingApps, proxyContexts }
}
async function terminal(onboarder: SlackOnboarder, id: string) {
  for await (const event of onboarder.poll(id)) if (event.type === 'success' || event.type === 'error') return event
  throw new Error('missing terminal')
}
describe('local Slack onboarding contract', () => {
  it('uses each channel name in the manifest consumed by CLI without changing another session', async () => {
    const { onboarder, dataDir, commands } = await setup()
    const first = await onboarder.begin({ instance_name: 'Slack-Team-A' })
    const second = await onboarder.begin({ instance_name: 'Slack-Team-B' })
    for (const [session, name] of [[first, 'Slack-Team-A'], [second, 'Slack-Team-B']] as const) {
      const manifest = JSON.parse(await fs.readFile(path.join(dataDir, 'slack-onboarding', session.session_id, 'project/manifest.json'), 'utf8'))
      const { stdout } = await promisify(execFile)(process.execPath, [path.join(dataDir, 'slack-onboarding', session.session_id, 'project/hook.mjs'), 'manifest'])
      expect(JSON.parse(stdout)).toEqual(manifest)
      expect(manifest.display_information.name).toBe(name)
      expect(manifest.features.bot_user.display_name).toBe(name)
      expect(manifest.oauth_config).toEqual(SLACK_MANIFEST.oauth_config)
      expect(manifest.settings).toEqual(SLACK_MANIFEST.settings)
    }
    expect(SLACK_MANIFEST.display_information.name).toBe('Crabot')
    expect(commands.some(args => args[0] === 'run')).toBe(false)
    await onboarder.dispose()
  })

  it('explains the Slack name limit before starting authorization rather than silently shortening the channel name', async () => {
    const { onboarder, commands } = await setup()
    await expect(onboarder.begin({ instance_name: 'a'.repeat(28) })).rejects.toMatchObject({ status: 400, code: 'invalid_input', message: expect.stringContaining('27') })
    expect(commands).toHaveLength(0)
    const accepted = await onboarder.begin({ instance_name: 'a'.repeat(27) })
    expect(accepted.ui_mode).toBe('challenge_code')
    await onboarder.dispose()
  })

  it('waits for an in-flight begin to release its resources during dispose', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-begin-test-')); roots.push(dataDir)
    let started!: () => void
    const preparing = new Promise<void>(resolve => { started = resolve })
    const launch = vi.fn()
    const onboarder = new SlackOnboarder({ dataDir, startCli: launch, ensureCli: async (_dir, signal) => {
      started()
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('fixture cancelled')), { once: true }))
      return 'never-executed'
    } })
    const begin = onboarder.begin()
    void begin.catch(() => {})
    await preparing
    await onboarder.dispose()
    await expect(begin).rejects.toThrow('准备失败')
    expect(launch).not.toHaveBeenCalled()
  })

  it('starts a fresh App after failed verification without retaining or reusing creation intent', async () => {
    const { onboarder, verify, dataDir, commands, preexistingApps } = await setup()
    verify.mockRejectedValueOnce(new Error('fixture platform verification failed'))
    const first = await onboarder.begin({ instance_name: 'slack-reuse' })
    await onboarder.submit(first.session_id, { challenge_code: 'fixture' })
    expect((await terminal(onboarder, first.session_id))?.type).toBe('error')
    const second = await onboarder.begin({ instance_name: 'SLACK-reuse' })
    await onboarder.submit(second.session_id, { challenge_code: 'fixture' })
    expect((await terminal(onboarder, second.session_id))?.type).toBe('success')
    const registry = JSON.parse(await fs.readFile(path.join(dataDir, 'slack-onboarding', second.session_id, 'project/.slack/apps.dev.json'), 'utf8'))
    expect(registry.TTEST.app_id).toBe('ATEST')
    expect(preexistingApps).toEqual([undefined, undefined])
    await expect(fs.access(path.join(dataDir, 'slack-onboarding', first.session_id))).rejects.toThrow()
    expect(commands.filter(args => args[0] === 'run')).toHaveLength(2)
    await onboarder.dispose()
  })
  it.each([
    { stage: 'creating' },
    { stage: 'creating', app_id: 'AOLD' },
    { stage: 'configured', app_id: 'AOLD' },
    'invalid legacy JSON',
  ])('does not read or use legacy intent when starting a new authorization: %j', async intent => {
    const { onboarder, dataDir, commands, preexistingApps } = await setup()
    const old = path.join(dataDir, 'slack-onboarding', '33333333-3333-4333-8333-333333333333')
    await fs.mkdir(old, { recursive: true })
    await fs.writeFile(path.join(old, 'intent.json'), typeof intent === 'string' ? intent : JSON.stringify({ requested_name: 'slack-unknown', team_id: 'TTEST', user_id: 'UTEST', ...intent }))
    const reads = vi.spyOn(fs, 'readFile')
    try {
      const begin = await onboarder.begin({ instance_name: 'slack-unknown' })
      await onboarder.submit(begin.session_id, { challenge_code: 'fixture' })
      expect((await terminal(onboarder, begin.session_id))?.type).toBe('success')
      expect(commands.filter(args => args[0] === 'run')).toHaveLength(1)
      expect(preexistingApps).toEqual([undefined])
      expect(reads.mock.calls.some(([file]) => path.basename(String(file)) === 'intent.json')).toBe(false)
      await expect(fs.access(path.join(dataDir, 'slack-onboarding', begin.session_id, 'intent.json'))).rejects.toThrow()
    } finally { reads.mockRestore(); await onboarder.dispose() }
  })

  it('hands off only after stopping CLI, retains a retryable result and clears developer credentials after durable creation', async () => {
    const { onboarder, dataDir, commands, stopped, verify, proxyContexts } = await setup()
    const begin = await onboarder.begin({ instance_name: 'Slack-local', __admin_proxy: { mode: 'none' } })
    expect(begin).toMatchObject({ ui_mode: 'challenge_code', authorization_command: '/slackauthticket fixture-ticket' })
    await onboarder.submit(begin.session_id, { challenge_code: 'fixture' })
    await expect(onboarder.submit(begin.session_id, { challenge_code: 'fixture' })).rejects.toMatchObject({ status: 409, code: 'session_busy' })
    expect(await terminal(onboarder, begin.session_id)).toEqual({ type: 'success' })
    expect(stopped).toEqual([true]); expect(verify).toHaveBeenCalledWith({ bot_token: 'xoxb-fixture', app_token: 'xapp-fixture' }, expect.objectContaining({ team_id: 'TTEST', user_id: 'UTEST' }), 'ATEST', expect.any(AbortSignal))
    const result = await onboarder.finish(begin.session_id)
    expect(result.authorized_identity).toEqual({ platform_user_id: 'UTEST' })
    expect(result.env.SLACK_ONLY_RESPOND_TO_MENTIONS).toBe('true')
    expect(await onboarder.finish(begin.session_id)).toEqual(result)
    expect(commands.filter(args => args[0] === 'run')).toHaveLength(1)
    expect(commands.flat()).not.toContain('--cleanup')
    expect(proxyContexts.every(value => (value as { mode: string }).mode === 'none')).toBe(true)
    await onboarder.finish(begin.session_id, { created_instance_id: 'slack-test' })
    const root = path.join(dataDir, 'slack-onboarding', begin.session_id)
    for (const item of ['cli', 'handoff.json', 'project']) await expect(fs.access(path.join(root, item))).rejects.toThrow()
    await expect(fs.access(root)).rejects.toThrow()
    expect(await onboarder.finish(begin.session_id)).toEqual(result)
    await onboarder.dispose()
  })
  it('rejects invalid/unknown/expired and duplicate terminal input without creating another App', async () => {
    const { onboarder, commands } = await setup({ waitMs: 5 })
    const begin = await onboarder.begin()
    for (const challenge_code of ['', '\ncommand', 'a\x00b']) await expect(onboarder.submit(begin.session_id, { challenge_code })).rejects.toMatchObject({ status: 400, code: 'invalid_input' })
    await new Promise(resolve => setTimeout(resolve, 10))
    await expect(onboarder.submit(begin.session_id, { challenge_code: 'fixture' })).rejects.toMatchObject({ status: 404 })
    expect(commands).toHaveLength(1)
    await onboarder.dispose()
  })
  it('bounds failed configuration and sanitizes platform/cleanup errors', async () => {
    const { onboarder, dataDir, stopped } = await setup({ fail: true, configureMs: 30 })
    const begin = await onboarder.begin()
    await onboarder.submit(begin.session_id, { challenge_code: 'fixture' })
    const event = await terminal(onboarder, begin.session_id)
    expect(event?.type).toBe('error'); expect(JSON.stringify(event)).not.toContain('xoxb-')
    expect(stopped.length).toBeGreaterThan(0)
    await onboarder.dispose()
    await expect(fs.access(path.join(dataDir, 'slack-onboarding', begin.session_id))).rejects.toThrow()
  })
  it('cleans a cancelled session completely before another same-name begin', async () => {
    const { onboarder, dataDir, preexistingApps } = await setup()
    const first = await onboarder.begin({ instance_name: 'slack-cancelled' })
    onboarder.cancel(first.session_id)
    const second = await onboarder.begin({ instance_name: 'slack-cancelled' })
    await expect(fs.access(path.join(dataDir, 'slack-onboarding', first.session_id))).rejects.toThrow()
    await onboarder.submit(second.session_id, { challenge_code: 'fixture' })
    expect((await terminal(onboarder, second.session_id))?.type).toBe('success')
    expect(preexistingApps).toEqual([undefined])
    await onboarder.dispose()
  })
  it('accepts the trusted Admin cleanup acknowledgement after restart without a second completion record', async () => {
    const { onboarder, dataDir } = await setup()
    const id = '44444444-4444-4444-8444-444444444444'
    const root = path.join(dataDir, 'slack-onboarding', id)
    await fs.mkdir(path.join(root, 'cli'), { recursive: true })
    await fs.writeFile(path.join(root, 'cli/credentials.json'), 'synthetic local developer credentials')
    await expect(onboarder.finish(id, { created_instance_id: 'slack-test' })).resolves.toEqual({ env: {} })
    await expect(fs.access(root)).rejects.toThrow()
    await expect(onboarder.finish(id, { created_instance_id: 'slack-test' })).resolves.toEqual({ env: {} })
    await expect(onboarder.finish('../outside', { created_instance_id: 'slack-test' })).rejects.toMatchObject({ code: 'session_not_found' })
    await onboarder.dispose()
  })
  it('reports a failed local App hook without exposing CLI output or credentials', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-hook-error-')); roots.push(dataDir)
    const launch = (_executable: string, args: string[], project: string): CliJob => ({
      result: (async () => {
        if (args.includes('--challenge')) {
          await fs.writeFile(args[args.indexOf('--config-dir') + 1] + '/credentials.json', JSON.stringify({ TTEST: { team_id: 'TTEST', user_id: 'UTEST' } }))
          return { code: 0, output: '' }
        }
        if (args[0] === 'run') return { code: 1, output: 'sdk_hook_invocation_failed xoxb-SECRET fixture-challenge' }
        return { code: 0, output: '/slackauthticket fixture-ticket' }
      })(),
      async stop() {},
    })
    const onboarder = new SlackOnboarder({ dataDir, ensureCli: async () => 'fixture', startCli: launch })
    const begin = await onboarder.begin({ __admin_proxy: { mode: 'custom', custom_url: 'http://127.0.0.1:7890' } })
    await onboarder.submit(begin.session_id, { challenge_code: 'fixture-challenge' })
    const event = await terminal(onboarder, begin.session_id)
    expect(event).toMatchObject({ type: 'error', message: expect.stringContaining('本地配置脚本') })
    expect(JSON.stringify(event)).not.toMatch(/xoxb-SECRET|fixture-challenge/)
    expect(event?.message).toContain('custom')
    await onboarder.dispose()
  }, 15000)

  it('does not publish success if owned process shutdown cannot be confirmed', async () => {
    const { onboarder } = await setup({ stopFails: true })
    const begin = await onboarder.begin()
    await onboarder.submit(begin.session_id, { challenge_code: 'fixture' })
    expect((await terminal(onboarder, begin.session_id))?.type).toBe('error')
    await expect(onboarder.dispose()).rejects.toThrow('清理未确认完成')
  })
  it('does not let a rejected old cleanup task block a new begin after no owned process remains', async () => {
    const { onboarder, dataDir } = await setup({ stopFails: true })
    const first = await onboarder.begin({ instance_name: 'slack-stopped' })
    await onboarder.submit(first.session_id, { challenge_code: 'fixture' })
    expect((await terminal(onboarder, first.session_id))?.type).toBe('error')
    onboarder.cancel(first.session_id)
    const second = await onboarder.begin({ instance_name: 'slack-stopped' })
    expect(second.session_id).not.toBe(first.session_id)
    await expect(fs.access(path.join(dataDir, 'slack-onboarding', first.session_id))).rejects.toThrow()
    await onboarder.dispose()
  })
  it('fixed manifest preserves scopes and messages without a competing socket', () => {
    expect(SLACK_MANIFEST.oauth_config.scopes.bot).toHaveLength(9)
    expect(SLACK_MANIFEST.settings).toMatchObject({ token_rotation_enabled: false, socket_mode_enabled: true })
    expect(SLACK_MANIFEST.settings.event_subscriptions.bot_events).toEqual(['message.channels', 'message.groups', 'message.im'])
  })
  it('retains Windows PowerShell module lookup/cache without forwarding model credentials', () => {
    const keys = ['PSModulePath', 'PSModuleAnalysisCachePath', 'OPENAI_API_KEY']
    const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    try {
      process.env.PSModulePath = 'fixture-module-path'
      process.env.PSModuleAnalysisCachePath = 'fixture-cache-path'
      process.env.OPENAI_API_KEY = 'fixture-model-secret'
      const env = cliEnvironment({ mode: 'none' })
      expect(env.PSModulePath).toBe('fixture-module-path')
      expect(env.PSModuleAnalysisCachePath).toBe('fixture-cache-path')
      expect(env.OPENAI_API_KEY).toBeUndefined()
    } finally {
      for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key] }
    }
  })
  it('passes a detected native proxy to its CLI without overwriting an inherited shell proxy', () => {
    const keys = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']
    const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    const detect = vi.spyOn(ProxyManager, 'resolveSystemProxyUrl').mockReturnValue('http://127.0.0.1:17890')
    try {
      for (const key of keys) delete process.env[key]
      const detected = cliEnvironment({ mode: 'system' })
      expect(detected.HTTP_PROXY).toBe('http://127.0.0.1:17890')
      expect(detected.HTTPS_PROXY).toBe('http://127.0.0.1:17890')
      process.env.http_proxy = 'http://shell.example:8080'
      const inherited = cliEnvironment({ mode: 'system' })
      expect(inherited.http_proxy).toBe('http://shell.example:8080')
      expect(inherited.HTTPS_PROXY).toBeUndefined()
    } finally {
      detect.mockRestore()
      for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key] }
    }
  })

  it('does not pass unrelated runtime credentials to CLI children', () => {
    const original = process.env.SLACK_APP_TOKEN
    process.env.SLACK_APP_TOKEN = 'xapp-do-not-inherit'
    try {
      expect(cliEnvironment()).not.toHaveProperty('SLACK_APP_TOKEN')
      const direct = cliEnvironment({ mode: 'none' })
      for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) expect(direct).not.toHaveProperty(key)
      expect(cliEnvironment({ mode: 'custom', custom_url: 'http://fixture.invalid:8080' }).HTTPS_PROXY).toBe('http://fixture.invalid:8080')
    } finally { if (original === undefined) delete process.env.SLACK_APP_TOKEN; else process.env.SLACK_APP_TOKEN = original }
  })
  it('refuses a corrupt archive without extracting or executing it', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-archive-test-')); roots.push(dataDir)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('corrupt')))
    await expect(ensureCli(dataDir, new AbortController().signal)).rejects.toThrow('校验失败')
  })
})
