import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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

  it('reuses only a recorded App from the same workspace/user/name after a failed verification', async () => {
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
    expect(preexistingApps).toEqual([undefined, 'ATEST'])
    expect(commands.filter(args => args[0] === 'run')).toHaveLength(2)
    await onboarder.dispose()
  })
  it('does not retry remote creation when a previous creation outcome is unknown', async () => {
    const { onboarder, dataDir, commands } = await setup()
    const old = path.join(dataDir, 'slack-onboarding', '33333333-3333-4333-8333-333333333333')
    await fs.mkdir(old, { recursive: true })
    await fs.writeFile(path.join(old, 'intent.json'), JSON.stringify({ requested_name: 'slack-unknown', team_id: 'TTEST', user_id: 'UTEST', stage: 'creating' }))
    const begin = await onboarder.begin({ instance_name: 'slack-unknown' })
    await onboarder.submit(begin.session_id, { challenge_code: 'fixture' })
    expect((await terminal(onboarder, begin.session_id))?.type).toBe('error')
    expect(commands.some(args => args[0] === 'run')).toBe(false)
    await onboarder.dispose()
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
    expect(JSON.parse(await fs.readFile(path.join(root, 'intent.json'), 'utf8'))).toMatchObject({ app_id: 'ATEST', instance_id: 'slack-test', stage: 'completed' })
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
    await expect(fs.access(path.join(dataDir, 'slack-onboarding', begin.session_id, 'cli'))).rejects.toThrow()
  })
  it('does not publish success if owned process shutdown cannot be confirmed', async () => {
    const { onboarder } = await setup({ stopFails: true })
    const begin = await onboarder.begin()
    await onboarder.submit(begin.session_id, { challenge_code: 'fixture' })
    expect((await terminal(onboarder, begin.session_id))?.type).toBe('error')
    await expect(onboarder.dispose()).rejects.toThrow('清理未确认完成')
  })
  it('fixed manifest preserves scopes and messages without a competing socket', () => {
    expect(SLACK_MANIFEST.oauth_config.scopes.bot).toHaveLength(9)
    expect(SLACK_MANIFEST.settings).toMatchObject({ token_rotation_enabled: false, socket_mode_enabled: true })
    expect(SLACK_MANIFEST.settings.event_subscriptions.bot_events).toEqual(['message.channels', 'message.groups', 'message.im'])
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
