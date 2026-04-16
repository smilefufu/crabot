import { Command } from 'commander'
import { createClient } from '../main.js'
import { printResult, shortId, type Column } from '../output.js'
import { parseKeyValuePairs } from './_utils.js'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'name', header: 'NAME' },
  { key: 'status', header: 'STATUS' },
]

export function registerAgentCommands(parent: Command): void {
  const agent = parent
    .command('agent')
    .description('Manage agent instances')

  agent
    .command('list')
    .description('List all agent instances')
    .action(async () => {
      const { client, json } = createClient(parent)
      const data = await client.get<unknown>('/api/agent-instances')
      printResult(data, json, COLUMNS)
    })

  agent
    .command('show <id>')
    .description('Show an agent instance')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.get<unknown>(`/api/agent-instances/${id}`)
      printResult(data, json, COLUMNS)
    })

  agent
    .command('config <id>')
    .description('Get or set agent instance config')
    .option('--set <pairs...>', 'Set config values (key=value, supports dot notation)')
    .action(async (id: string, opts: { set?: string[] }) => {
      const { client, json } = createClient(parent)

      if (opts.set && opts.set.length > 0) {
        const body = parseKeyValuePairs(opts.set)
        const data = await client.patch<unknown>(`/api/agent-instances/${id}/config`, body)
        printResult(data, json)
      } else {
        const data = await client.get<unknown>(`/api/agent-instances/${id}/config`)
        printResult(data, json)
      }
    })

  agent
    .command('restart <id>')
    .description('Restart an agent instance')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.post<unknown>(`/api/agent-instances/${id}/restart`)
      printResult(data, json)
    })
}
