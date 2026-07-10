/**
 * 分析 OpenClaw `channels.<name>.accounts`，判定各 channel 账号可迁性。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §3 / §5.2
 * 决策：仅 telegram / feishu / lark 可迁；其余已知 channel 灰显。
 * 安全：输出发给 UI，不含明文 secret，只标 credentials availability。
 */
import type { OpenClawChannelAccount, OpenClawChannelsConfig } from './openclaw-config.js'
import { resolveSecret } from './resolve-secret.js'
import { isValidChannelInstanceName } from './channel-instance-name.js'

export type AnalyzedChannel = {
  /** OpenClaw channels 的 key（如 feishu/telegram） */
  source_channel: string
  /** 账号 id（telegram 顶层 botToken 归为 'default'） */
  account_id?: string
  /** 归一化 channel 标识 */
  channel: string
  migratable: boolean
  crabot_type?: 'telegram' | 'feishu'
  feishu_domain?: 'feishu' | 'lark'
  /** 必需明文 secret 是否齐全（available 才能无痛迁，unavailable 需用户手填） */
  credentials?: 'available' | 'unavailable'
  skip_reason?: 'unsupported-channel' | 'invalid-name'
}

const MIGRATABLE: Record<string, Pick<AnalyzedChannel, 'crabot_type' | 'feishu_domain'>> = {
  telegram: { crabot_type: 'telegram' },
  feishu: { crabot_type: 'feishu', feishu_domain: 'feishu' },
  lark: { crabot_type: 'feishu', feishu_domain: 'lark' },
}

/** 账号是否带任何凭证字段（区分真实 channel 账号 vs 纯策略账号）。 */
function hasCredentialField(account: OpenClawChannelAccount): boolean {
  return 'appId' in account || 'appSecret' in account || 'botToken' in account
}

/** 判断某账号在该 channel 下的必需明文 secret 是否齐全。 */
function credentialsAvailable(channel: string, account: OpenClawChannelAccount): boolean {
  if (channel === 'telegram') {
    return resolveSecret(account.botToken) !== undefined
  }
  // feishu / lark
  return resolveSecret(account.appId) !== undefined && resolveSecret(account.appSecret) !== undefined
}

export function analyzeChannels(channels: OpenClawChannelsConfig | undefined): AnalyzedChannel[] {
  if (!channels) return []

  const result: AnalyzedChannel[] = []
  for (const [source_channel, cfg] of Object.entries(channels)) {
    const channel = source_channel
    const migratable = MIGRATABLE[channel]

    if (!migratable) {
      result.push({ source_channel, channel, migratable: false, skip_reason: 'unsupported-channel' })
      continue
    }

    // 收集带凭证的账号；telegram 顶层 botToken 归一为 default 账号。
    const accounts: Array<[string, OpenClawChannelAccount]> = Object.entries(cfg.accounts ?? {}).filter(
      ([, account]) => hasCredentialField(account),
    )
    if (channel === 'telegram' && cfg.botToken !== undefined && accounts.length === 0) {
      accounts.push(['default', { botToken: cfg.botToken }])
    }

    for (const [account_id, account] of accounts) {
      // 派生实例名非法（account_id 含大写/点号等）→ 预览即标不可迁，
      // 与执行侧（import-channels）判定一致，避免“预览可迁、执行跳过”。
      if (!isValidChannelInstanceName(source_channel, account_id)) {
        result.push({ source_channel, account_id, channel, migratable: false, skip_reason: 'invalid-name' })
        continue
      }
      result.push({
        source_channel,
        account_id,
        channel,
        migratable: true,
        ...migratable,
        credentials: credentialsAvailable(channel, account) ? 'available' : 'unavailable',
      })
    }
  }
  return result
}
