import { Command } from 'commander'
import { createClient } from '../main.js'
import { printResult, shortId, type Column } from '../output.js'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'name', header: 'NAME' },
  { key: 'type', header: 'TYPE' },
]

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf-8').trim()
}

export function registerProviderCommands(parent: Command): void {
  const provider = parent
    .command('provider')
    .description('Manage model providers')

  provider
    .command('list')
    .description('List all model providers')
    .action(async () => {
      const { client, json } = createClient(parent)
      const data = await client.get<unknown>('/api/model-providers')
      printResult(data, json, COLUMNS)
    })

  provider
    .command('show <id>')
    .description('Show a model provider')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.get<unknown>(`/api/model-providers/${id}`)
      printResult(data, json, COLUMNS)
    })

  provider
    .command('add')
    .description('Add a model provider')
    .requiredOption('--name <name>', 'Provider name')
    .requiredOption('--type <type>', 'Provider type')
    .requiredOption('--endpoint <url>', 'Provider endpoint URL')
    .option('--apikey <key>', 'API key')
    .option('--apikey-stdin', 'Read API key from stdin')
    .action(async (opts: {
      name: string
      type: string
      endpoint: string
      apikey?: string
      apikeyStdin?: boolean
    }) => {
      const { client, json } = createClient(parent)

      let apikey = opts.apikey ?? ''
      if (opts.apikeyStdin) {
        apikey = await readStdin()
      }

      const body = {
        name: opts.name,
        type: opts.type,
        endpoint: opts.endpoint,
        apikey,
      }

      const data = await client.post<unknown>('/api/model-providers', body)
      printResult(data, json, COLUMNS)
    })

  provider
    .command('test <id>')
    .description('Test a model provider connection')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.post<unknown>(`/api/model-providers/${id}/test`)
      printResult(data, json)
    })

  provider
    .command('refresh <id>')
    .description('Refresh models for a provider')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.post<unknown>(`/api/model-providers/${id}/refresh-models`)
      printResult(data, json)
    })

  provider
    .command('delete <id>')
    .description('Delete a model provider')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      await client.delete<unknown>(`/api/model-providers/${id}`)
      if (!json) {
        console.log(`Provider ${shortId(id)} deleted.`)
      }
    })
}
