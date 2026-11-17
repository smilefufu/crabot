import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ChannelManager } from './channel-manager.js'
import { installTestChannel } from '../tests/helpers/installed-channel.js'
import { WechatChannel } from '../../crabot-channel-wechat/src/wechat-channel.js'
import { createConfig } from '../../crabot-channel-wechat/src/main.js'

describe('WeChat runtime configuration survives module restart', () => {
  let dir: string
  let manager: ChannelManager
  let channel: WechatChannel

  async function boot() {
    const env = await (manager as any).buildModuleEnv(manager.getInstance('wechat-test'))
    channel = new WechatChannel(createConfig({ ...env, CRABOT_PORT: '19001' }))
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-config-'))
    manager = new ChannelManager(dir, {
      registerModuleDefinition: vi.fn(),
      resolve: vi.fn(async () => [{ port: 19001 }]),
      call: vi.fn(async (_port: number, method: string, params: any) => method === 'get_config'
        ? (channel as any).handleGetConfig()
        : (channel as any).handleUpdateConfig(params)),
    } as any)
    await installTestChannel(dir, 'wechat')
    await manager.initialize()
    await manager.createInstance({
      implementation_id: 'channel-wechat', name: 'wechat-test', auto_start: false,
      env: { WECHAT_CONNECTOR_URL: 'http://127.0.0.1:1', WECHAT_API_KEY: 'wct-test', UNRELATED: 'keep' },
    })
    await boot()
  })

  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it.each([true, false, 'true', 'false'])('persists %s without overwriting masked credentials', async value => {
    const current = (await manager.getConfig('wechat-test')).config
    const result = await manager.updateConfig({
      instance_id: 'wechat-test',
      config: { ...current, group: { only_respond_to_mentions: value as boolean } },
    })
    const expected = value === true || value === 'true'
    expect(result.config.group.only_respond_to_mentions).toBe(expected)
    expect(result.requires_restart).toBe(false)
    expect(await manager.loadLocalConfig('wechat-test')).toEqual({
      WECHAT_CONNECTOR_URL: 'http://127.0.0.1:1', WECHAT_API_KEY: 'wct-test', UNRELATED: 'keep',
      WECHAT_ONLY_RESPOND_TO_MENTIONS: String(expected),
    })
    await boot()
    expect((await manager.getConfig('wechat-test')).config.group.only_respond_to_mentions).toBe(expected)
  })

  it('rejects an invalid boolean before changing other fields or persisted configuration', async () => {
    const saved = await manager.loadLocalConfig('wechat-test')
    await expect(manager.updateConfig({ instance_id: 'wechat-test', config: {
      credentials: { api_key: 'must-not-apply' }, group: { only_respond_to_mentions: 'yes' as any },
    } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    expect(await manager.loadLocalConfig('wechat-test')).toEqual(saved)
    expect((channel as any).wechatConfig.api_key).toBe('wct-test')
    expect((await manager.getConfig('wechat-test')).config.group.only_respond_to_mentions).toBe(false)
  })

  it('keeps an explicit false after previously saving true and restarting', async () => {
    await manager.updateConfig({ instance_id: 'wechat-test', config: { group: { only_respond_to_mentions: true } } })
    await boot()
    await manager.updateConfig({ instance_id: 'wechat-test', config: { group: { only_respond_to_mentions: false } } })
    await boot()
    expect((await manager.getConfig('wechat-test')).config.group.only_respond_to_mentions).toBe(false)
    expect((await manager.loadLocalConfig('wechat-test'))?.WECHAT_ONLY_RESPOND_TO_MENTIONS).toBe('false')
  })

  it('serializes concurrent saves so the last value survives restart', async () => {
    let release!: () => void
    let started!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const writing = new Promise<void>(resolve => { started = resolve })
    const save = manager.saveLocalConfig.bind(manager)
    vi.spyOn(manager, 'saveLocalConfig').mockImplementationOnce(async (id, config) => {
      started()
      await pending
      await save(id, config)
    })
    const first = manager.updateConfig({ instance_id: 'wechat-test', config: { group: { only_respond_to_mentions: true } } })
    await writing
    const last = manager.updateConfig({ instance_id: 'wechat-test', config: { group: { only_respond_to_mentions: false } } })
    release()
    await Promise.all([first, last])
    await boot()
    expect((await manager.getConfig('wechat-test')).config.group.only_respond_to_mentions).toBe(false)
    expect((await manager.loadLocalConfig('wechat-test'))?.WECHAT_ONLY_RESPOND_TO_MENTIONS).toBe('false')
  })

  it('reports persistence failure and allows the next save to succeed', async () => {
    const write = vi.spyOn(manager, 'saveLocalConfig').mockRejectedValueOnce(new Error('disk full'))
    const params = { instance_id: 'wechat-test', config: { group: { only_respond_to_mentions: true } } }
    await expect(manager.updateConfig(params)).rejects.toThrow('disk full')
    expect((await manager.loadLocalConfig('wechat-test'))?.WECHAT_ONLY_RESPOND_TO_MENTIONS).toBeUndefined()
    await manager.updateConfig(params)
    expect(write).toHaveBeenCalledTimes(2)
    await boot()
    expect((await manager.getConfig('wechat-test')).config.group.only_respond_to_mentions).toBe(true)
  })
})
