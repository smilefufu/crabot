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

export function registerAgentCommands(parent: Command): void {
  const agent = parent.command('agent').description('Manage agent instances')

  agent
    .command('list')
    .description('List all agent instances')
    .action(async () => {
      const ctx = createContext(parent)
      const data = await ctx.client.get<unknown>('/api/agent-instances')
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  agent
    .command('show <ref>')
    .description('Show an agent instance')
    .action(async (ref: string) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'agent', ref)
      const data = await ctx.client.get<unknown>(`/api/agent-instances/${id}`)
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  agent
    .command('config <ref>')
    .description('Get or set agent instance config')
    .option('--set <pairs...>', 'Set config values (key=value, supports dot notation)')
    .action(async (ref: string, opts: { set?: string[] }) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'agent', ref)

      if (opts.set && opts.set.length > 0) {
        const body = parseKeyValuePairs(opts.set)
        const before = await ctx.client.get<unknown>(`/api/agent-instances/${id}/config`)
        const result = await runWrite({
          subcommand: 'agent config',
          args: { '_positional': ref, '--set': opts.set.join(' ') },
          command_text: `agent config ${ref} --set ${opts.set.join(' ')}`,
          execute: () => ctx.client.patch(`/api/agent-instances/${id}/config`, body),
          reverse: {
            command: `agent config ${ref} --restore-snapshot`,
            preview_description: `restore agent ${ref} config to snapshot taken before this change`,
          },
          snapshot: before,
          dataDir: ctx.dataDir,
          actor: ctx.actor,
          mode: ctx.mode,
        })
        renderResult(maskSensitive(result), { mode: ctx.mode })
      } else {
        const data = await ctx.client.get<unknown>(`/api/agent-instances/${id}/config`)
        renderResult(maskSensitive(data), { mode: ctx.mode })
      }
    })

  agent
    .command('restart <ref>')
    .description('Restart an agent instance')
    .action(async (ref: string) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'agent', ref)
      const data = await ctx.client.post<unknown>(`/api/agent-instances/${id}/restart`)
      renderResult(data, { mode: ctx.mode })
    })
}
