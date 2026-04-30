import { Command } from 'commander'
import { createContext } from '../main.js'
import { renderResult, type Column, shortId } from '../output.js'
import { resolveRef } from '../resolve.js'
import { maskSensitive } from '../mask.js'
import { runWrite } from '../run-write.js'
import { parseKeyValuePairs } from './_utils.js'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'name', header: 'NAME' },
  { key: 'status', header: 'STATUS' },
]

export function registerChannelCommands(parent: Command): void {
  const channel = parent.command('channel').description('Manage channel instances')

  channel
    .command('list')
    .description('List all channel instances')
    .action(async () => {
      const ctx = createContext(parent)
      const data = await ctx.client.get<unknown>('/api/channel-instances')
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  channel
    .command('show <ref>')
    .description('Show a channel instance')
    .action(async (ref: string) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'channel', ref)
      const data = await ctx.client.get<unknown>(`/api/channel-instances/${id}`)
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  channel
    .command('config <ref>')
    .description('Get or set channel instance config')
    .option('--set <pairs...>', 'Set config values (key=value, supports dot notation)')
    .action(async (ref: string, opts: { set?: string[] }) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'channel', ref)

      if (opts.set && opts.set.length > 0) {
        // admin 协议 PATCH body 是 { config: Partial<ChannelConfig> }（外层包一层 config:）
        const config = parseKeyValuePairs(opts.set)
        const before = await ctx.client.get<unknown>(`/api/channel-instances/${id}/config`)
        const result = await runWrite({
          subcommand: 'channel config',
          args: { _positional: ref, '--set': opts.set.join(' ') },
          command_text: `channel config ${ref} --set ${opts.set.join(' ')}`,
          execute: () => ctx.client.patch(`/api/channel-instances/${id}/config`, { config }),
          reverse: {
            command: `channel config ${ref} --restore-snapshot`,
            preview_description: `restore channel ${ref} config to snapshot taken before this change`,
          },
          snapshot: before,
          dataDir: ctx.dataDir,
          actor: ctx.actor,
          mode: ctx.mode,
        })
        renderResult(maskSensitive(result), { mode: ctx.mode })
      } else {
        const data = await ctx.client.get<unknown>(`/api/channel-instances/${id}/config`)
        renderResult(maskSensitive(data), { mode: ctx.mode })
      }
    })

  channel
    .command('start <ref>')
    .description('Start a channel instance')
    .action(async (ref: string) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'channel', ref)
      const data = await ctx.client.post<unknown>(`/api/channel-instances/${id}/start`)
      renderResult(data, { mode: ctx.mode })
    })

  channel
    .command('stop <ref>')
    .description('Stop a channel instance')
    .action(async (ref: string) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'channel', ref)
      const data = await ctx.client.post<unknown>(`/api/channel-instances/${id}/stop`)
      renderResult(data, { mode: ctx.mode })
    })

  channel
    .command('restart <ref>')
    .description('Restart a channel instance')
    .action(async (ref: string) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'channel', ref)
      const data = await ctx.client.post<unknown>(`/api/channel-instances/${id}/restart`)
      renderResult(data, { mode: ctx.mode })
    })
}
