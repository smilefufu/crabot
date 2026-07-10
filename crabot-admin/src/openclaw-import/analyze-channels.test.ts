/**
 * OpenClaw channel 可迁性分析测试（基于真实备份的 channels.accounts 结构）。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §3 / §5.2
 * 决策：仅 telegram / feishu / lark 可迁，其余灰显。
 * 安全：分析结果发给 UI，不含明文 secret，只标 credentials: available/unavailable。
 */
import { describe, it, expect } from 'vitest'
import { analyzeChannels } from './analyze-channels.js'
import type { OpenClawChannelsConfig } from './openclaw-config.js'

describe('analyzeChannels', () => {
  it('feishu accounts.main 有 appId+appSecret 明文 → 可迁，credentials=available', () => {
    const channels: OpenClawChannelsConfig = {
      feishu: {
        enabled: true,
        accounts: {
          main: { appId: 'cli_x', appSecret: 's'.repeat(32) },
          default: {}, // 纯策略账号，无凭证
        },
      },
    }

    const result = analyzeChannels(channels)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      source_channel: 'feishu',
      account_id: 'main',
      channel: 'feishu',
      migratable: true,
      crabot_type: 'feishu',
      feishu_domain: 'feishu',
      credentials: 'available',
    })
  })

  it('appSecret 是 SecretRef → credentials=unavailable（仍列出，提示需手填）', () => {
    const channels: OpenClawChannelsConfig = {
      feishu: { accounts: { main: { appId: 'cli_x', appSecret: { source: 'env', provider: 'd', id: 'K' } } } },
    }

    const result = analyzeChannels(channels)

    expect(result[0]).toMatchObject({ migratable: true, credentials: 'unavailable' })
  })

  it('telegram accounts.<id>.botToken → channel=telegram，crabot_type=telegram', () => {
    const channels: OpenClawChannelsConfig = { telegram: { accounts: { bot1: { botToken: '123:abc' } } } }

    const result = analyzeChannels(channels)

    expect(result[0]).toMatchObject({ channel: 'telegram', crabot_type: 'telegram', account_id: 'bot1', credentials: 'available' })
  })

  it('telegram 顶层 botToken（无 accounts）→ 归为 default 账号', () => {
    const channels: OpenClawChannelsConfig = { telegram: { botToken: '123:abc' } }

    const result = analyzeChannels(channels)

    expect(result[0]).toMatchObject({ channel: 'telegram', account_id: 'default', credentials: 'available' })
  })

  it('lark → crabot_type=feishu，domain=lark', () => {
    const channels: OpenClawChannelsConfig = { lark: { accounts: { main: { appId: 'a', appSecret: 's' } } } }

    expect(analyzeChannels(channels)[0]).toMatchObject({ crabot_type: 'feishu', feishu_domain: 'lark' })
  })

  it('不支持的 channel（dingtalk/qq）→ 一条 unsupported 记录，不迁', () => {
    const channels: OpenClawChannelsConfig = {
      dingtalk: { accounts: { main: { appId: 'a' } } },
      qq: { enabled: true },
    }

    const result = analyzeChannels(channels)

    expect(result).toHaveLength(2)
    for (const ch of result) {
      expect(ch.migratable).toBe(false)
      expect(ch.skip_reason).toBe('unsupported-channel')
    }
  })

  it('支持的 channel 但无任何凭证账号（纯策略）→ 不产出', () => {
    const channels: OpenClawChannelsConfig = { feishu: { enabled: true, accounts: { default: { } } } }

    expect(analyzeChannels(channels)).toEqual([])
  })

  it('账号派生出非法实例名（account_id 含点号/大写）→ 预览即标不可迁 invalid-name', () => {
    const channels: OpenClawChannelsConfig = {
      feishu: { accounts: { 'Bad.Name': { appId: 'cli_x', appSecret: 'secret32' } } },
    }

    const result = analyzeChannels(channels)

    expect(result).toHaveLength(1)
    expect(result[0].migratable).toBe(false)
    expect(result[0].skip_reason).toBe('invalid-name')
  })

  it('空/缺失 → 空数组', () => {
    expect(analyzeChannels(undefined)).toEqual([])
    expect(analyzeChannels({})).toEqual([])
  })
})
