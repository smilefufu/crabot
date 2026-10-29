import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Onboarder } from 'crabot-shared'
import type { ChannelManager } from './channel-manager.js'
import { SlackOnboardingSessions } from './slack-onboarding-sessions.js'
import { OnboardingManager } from './onboarding-manager.js'
const id = '11111111-1111-4111-8111-111111111111'
let root: string
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-admin-test-')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
function setup() {
  const result = { env: { SLACK_BOT_TOKEN: 'xoxb-fixture', SLACK_APP_TOKEN: 'xapp-fixture' }, authorized_identity: { platform_user_id: 'UOWNER' } }
  const onboarder = { begin: vi.fn(async () => ({ session_id: id, ui_mode: 'challenge_code' as const })), finish: vi.fn(async () => result), poll: vi.fn(), cancel: vi.fn() } as unknown as Onboarder
  let instance: any
  const channels = { listInstances: vi.fn(() => ({ items: instance ? [instance] : [] })), getInstance: vi.fn(() => instance), loadLocalConfig: vi.fn(async () => result.env), createInstance: vi.fn(async (params: any) => { instance = { id: params.name, name: params.name, implementation_id: params.implementation_id }; return instance }) } as unknown as ChannelManager
  return { onboarder, channels, sessions: new SlackOnboardingSessions(root) }
}
describe('Slack onboarding Admin ownership and completion', () => {
  it('never resurrects a deleted completed instance from an old authorization', async () => {
    const { sessions, onboarder, channels } = setup()
    await sessions.begin('human:0', onboarder)
    await sessions.finish('human:0', id, 'slack-one', onboarder, channels)
    vi.mocked(channels.getInstance).mockReturnValue(undefined)
    await expect(sessions.finish('human:0', id, 'slack-one', onboarder, channels)).rejects.toMatchObject({ status: 409 })
    expect(channels.createInstance).toHaveBeenCalledTimes(1)
  })
  it('keeps completion idempotent after a normal group-filter hot update', async () => {
    const { sessions, onboarder, channels } = setup()
    await sessions.begin('human:0', onboarder)
    const response = await sessions.finish('human:0', id, 'slack-one', onboarder, channels)
    vi.mocked(channels.loadLocalConfig).mockResolvedValue({ SLACK_BOT_TOKEN: 'xoxb-fixture', SLACK_APP_TOKEN: 'xapp-fixture', SLACK_ONLY_RESPOND_TO_MENTIONS: 'false' })
    expect(await sessions.finish('human:0', id, 'slack-one', onboarder, channels)).toEqual(response)
    expect(channels.createInstance).toHaveBeenCalledTimes(1)
  })
  it('checks name conflicts before asking the platform for a new authorization', async () => {
    const { sessions, onboarder, channels } = setup()
    vi.mocked(channels.listInstances).mockReturnValue({ items: [{ id: 'SLACK-one' }], pagination: {} } as never)
    await expect(sessions.begin('human:0', onboarder, { instance_name: 'slack-one' }, channels)).rejects.toMatchObject({ status: 409 })
    expect(onboarder.begin).not.toHaveBeenCalled()
  })

  it('rejects anonymous/internal ownership and cross-principal sessions', async () => {
    const { sessions, onboarder } = setup()
    await expect(sessions.begin(undefined, onboarder)).rejects.toMatchObject({ status: 403 })
    expect(onboarder.begin).not.toHaveBeenCalled()
    await sessions.begin('human-a:0', onboarder)
    await expect(sessions.assertOwner('human-b:0', id)).rejects.toMatchObject({ status: 403 })
    await expect(sessions.assertOwner('human-a:0', '../escape')).rejects.toMatchObject({ status: 404 })
  })
  it('serializes duplicate finishes, returns the same instance and never emits env or automatic Master metadata', async () => {
    const { sessions, onboarder, channels } = setup()
    await sessions.begin('human:0', onboarder)
    const responses = await Promise.all([sessions.finish('human:0', id, 'slack-one', onboarder, channels), sessions.finish('human:0', id, 'slack-one', onboarder, channels)])
    expect(responses[0]).toEqual(responses[1])
    expect(channels.createInstance).toHaveBeenCalledTimes(1)
    expect(responses[0]).toMatchObject({ instance: { id: 'slack-one' }, authorized_identity: { platform_user_id: 'UOWNER' }, push_sent: false })
    expect(JSON.stringify(responses)).not.toMatch(/xoxb-|xapp-|master_friend_id|SLACK_BOT_TOKEN/)
    await expect(sessions.finish('human:0', id, 'other-name', onboarder, channels)).rejects.toMatchObject({ status: 409 })
    const restarted = new SlackOnboardingSessions(root)
    await expect(restarted.finish('human:0', id, 'slack-one', onboarder, channels)).resolves.toEqual(responses[0])
    expect(channels.createInstance).toHaveBeenCalledTimes(1)
  })
  it('retries an instance creation failure with the same tokens and without running begin again', async () => {
    const { sessions, onboarder, channels } = setup()
    const original = channels.createInstance
    vi.mocked(channels.createInstance).mockRejectedValueOnce(new Error('registration failed'))
    await sessions.begin('human:0', onboarder)
    await expect(sessions.finish('human:0', id, 'slack-one', onboarder, channels)).rejects.toThrow('registration failed')
    await sessions.finish('human:0', id, 'slack-one', onboarder, channels)
    expect(original).toHaveBeenCalledTimes(2)
    expect(onboarder.begin).toHaveBeenCalledTimes(1)
  })
  it('refuses an unrelated same-name instance and does not adopt another installation on retry', async () => {
    const { sessions, onboarder, channels } = setup()
    await sessions.begin('human:0', onboarder)
    vi.mocked(channels.getInstance).mockReturnValue({ id: 'slack-one', implementation_id: 'channel-slack' } as never)
    vi.mocked(channels.listInstances).mockReturnValue({ items: [{ id: 'SLACK-one' }], pagination: {} } as never)
    await expect(sessions.finish('human:0', id, 'slack-one', onboarder, channels)).rejects.toMatchObject({ status: 409 })
    expect(channels.createInstance).not.toHaveBeenCalled()
  })
  it('awaits optional owned-resource cleanup without changing stopGc semantics', async () => {
    const manager = new OnboardingManager()
    const calls: string[] = []
    const dispose = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 10)); calls.push('disposed') })
    ;(manager as any).onboarders.set('slack', { onboarder: { stopGc() { calls.push('gc') }, dispose } })
    await manager.shutdown()
    expect(calls).toEqual(['gc', 'disposed'])
  })
})
