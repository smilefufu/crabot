/**
 * channel 导入编排测试：提取 secret → 映射 → 冲突跳过 → createInstance。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.2 / §8
 */
import { describe, it, expect, vi } from 'vitest'
import { importChannels } from './import-channels.js'
import type { OpenClawChannelsConfig } from './openclaw-config.js'
import type { CreateChannelInstanceParams } from '../types.js'

const channels: OpenClawChannelsConfig = {
  feishu: {
    accounts: {
      main: { appId: 'cli_x', appSecret: 'secret32' },
      ref: { appId: 'cli_y', appSecret: { source: 'env', provider: 'd', id: 'K' } },
    },
  },
}

function makeDeps(existing: string[] = []) {
  const created: CreateChannelInstanceParams[] = []
  return {
    created,
    deps: {
      existingChannelNames: new Set(existing),
      createChannel: vi.fn(async (p: CreateChannelInstanceParams) => {
        created.push(p)
      }),
    },
  }
}

describe('importChannels', () => {
  it('feishu/main 有明文凭证、无冲突 → createInstance，name=feishu-main，env 正确', async () => {
    const { created, deps } = makeDeps()

    const results = await importChannels(channels, [{ source_channel: 'feishu', account_id: 'main' }], deps)

    expect(deps.createChannel).toHaveBeenCalledTimes(1)
    expect(created[0]).toMatchObject({
      implementation_id: 'channel-feishu',
      name: 'feishu-main',
      env: { FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 'secret32', FEISHU_DOMAIN: 'feishu' },
    })
    expect(results).toEqual([{ kind: 'channel', name: 'feishu-main', status: 'imported' }])
  })

  it('crabot 已存在同名实例 → 跳过 conflict', async () => {
    const { deps } = makeDeps(['feishu-main'])

    const results = await importChannels(channels, [{ source_channel: 'feishu', account_id: 'main' }], deps)

    expect(deps.createChannel).not.toHaveBeenCalled()
    expect(results).toEqual([{ kind: 'channel', name: 'feishu-main', status: 'skipped', reason: 'conflict' }])
  })

  it('secret 是 SecretRef（明文不在备份）→ 跳过 missing-secret', async () => {
    const { deps } = makeDeps()

    const results = await importChannels(channels, [{ source_channel: 'feishu', account_id: 'ref' }], deps)

    expect(deps.createChannel).not.toHaveBeenCalled()
    expect(results).toEqual([{ kind: 'channel', name: 'feishu-ref', status: 'skipped', reason: 'missing-secret' }])
  })

  it('account_id 派生出非法实例名（Bad.Name）→ 预校验跳过 invalid-name，不调 createChannel；合法账号仍导入', async () => {
    const twoAccounts: OpenClawChannelsConfig = {
      feishu: {
        accounts: {
          'Bad.Name': { appId: 'cli_x', appSecret: 'secret32' },
          main: { appId: 'cli_y', appSecret: 'secret64' },
        },
      },
    }
    const { created, deps } = makeDeps()

    const results = await importChannels(
      twoAccounts,
      [
        { source_channel: 'feishu', account_id: 'Bad.Name' },
        { source_channel: 'feishu', account_id: 'main' },
      ],
      deps,
    )

    // 非法名走确定性预校验跳过，不进入 createChannel
    expect(deps.createChannel).toHaveBeenCalledTimes(1)
    expect(created.map((p) => p.name)).toEqual(['feishu-main'])
    expect(results).toEqual([
      { kind: 'channel', name: 'feishu-Bad.Name', status: 'skipped', reason: 'invalid-name' },
      { kind: 'channel', name: 'feishu-main', status: 'imported' },
    ])
  })

  it('createChannel 抛运行时错误（如磁盘/MM 故障）→ 向上传播，不吞成 skipped', async () => {
    const { deps } = makeDeps()
    deps.createChannel = vi.fn(async () => {
      throw new Error('ENOSPC: no space left on device')
    })

    await expect(
      importChannels(channels, [{ source_channel: 'feishu', account_id: 'main' }], deps),
    ).rejects.toThrow(/ENOSPC/)
  })
})
