import { Command } from 'commander'
import { createClient } from '../main.js'
import { printResult, shortId, type Column } from '../output.js'
import { parseKeyValuePairs } from './_utils.js'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'name', header: 'NAME' },
  { key: 'status', header: 'STATUS' },
]

export function registerChannelCommands(parent: Command): void {
  const channel = parent
    .command('channel')
    .description('Manage channel instances')

  channel
    .command('list')
    .description('List all channel instances')
    .action(async () => {
      const { client, json } = createClient(parent)
      const data = await client.get<unknown>('/api/channel-instances')
      printResult(data, json, COLUMNS)
    })

  channel
    .command('show <id>')
    .description('Show a channel instance')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.get<unknown>(`/api/channel-instances/${id}`)
      printResult(data, json, COLUMNS)
    })

  channel
    .command('config <id>')
    .description('Get or set channel instance config')
    .option('--set <pairs...>', 'Set config values (key=value)')
    .action(async (id: string, opts: { set?: string[] }) => {
      const { client, json } = createClient(parent)

      if (opts.set && opts.set.length > 0) {
        const body = parseKeyValuePairs(opts.set)
        const data = await client.patch<unknown>(`/api/channel-instances/${id}/config`, body)
        printResult(data, json)
      } else {
        const data = await client.get<unknown>(`/api/channel-instances/${id}/config`)
        printResult(data, json)
      }
    })

  channel
    .command('start <id>')
    .description('Start a channel instance')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.post<unknown>(`/api/channel-instances/${id}/start`)
      printResult(data, json)
    })

  channel
    .command('stop <id>')
    .description('Stop a channel instance')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.post<unknown>(`/api/channel-instances/${id}/stop`)
      printResult(data, json)
    })

  channel
    .command('restart <id>')
    .description('Restart a channel instance')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.post<unknown>(`/api/channel-instances/${id}/restart`)
      printResult(data, json)
    })
}
