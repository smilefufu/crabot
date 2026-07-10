/**
 * channel 导入编排：提取 secret → 映射 → 冲突检测 → 创建实例。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.2 / §8
 * 实例命名 `<channel>-<account>`；缺明文 secret 跳过 missing-secret；同名跳过 conflict。
 */
import type { CreateChannelInstanceParams } from '../types.js'
import type { OpenClawChannelsConfig } from './openclaw-config.js'
import { extractChannelSecrets } from './extract-channel-secrets.js'
import { mapChannel } from './map-channel.js'
import type { ImportItemResult } from './import-types.js'

export type ChannelImportDeps = {
  existingChannelNames: Set<string>
  createChannel: (params: CreateChannelInstanceParams) => Promise<void>
}

export type ChannelSelection = { source_channel: string; account_id: string }

const SUPPORTED = new Set(['telegram', 'feishu', 'lark'])

export async function importChannels(
  channels: OpenClawChannelsConfig | undefined,
  selected: ChannelSelection[],
  deps: ChannelImportDeps,
): Promise<ImportItemResult[]> {
  if (!channels) return []
  const results: ImportItemResult[] = []

  for (const { source_channel, account_id } of selected) {
    const name = `${source_channel}-${account_id}`

    if (!SUPPORTED.has(source_channel)) {
      results.push({ kind: 'channel', name, status: 'skipped', reason: 'not-migratable' })
      continue
    }

    const secrets = extractChannelSecrets(channels, source_channel, account_id)
    const mapped = mapChannel({ channel: source_channel as 'telegram' | 'feishu' | 'lark', name, secrets })
    if (!mapped.ok) {
      results.push({ kind: 'channel', name, status: 'skipped', reason: 'missing-secret' })
      continue
    }

    if (deps.existingChannelNames.has(name)) {
      results.push({ kind: 'channel', name, status: 'skipped', reason: 'conflict' })
      continue
    }

    try {
      await deps.createChannel(mapped.params)
      results.push({ kind: 'channel', name, status: 'imported' })
    } catch (err) {
      results.push({
        kind: 'channel',
        name,
        status: 'skipped',
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return results
}
