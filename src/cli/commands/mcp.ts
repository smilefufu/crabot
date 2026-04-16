import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { createClient } from '../main.js'
import { printResult, shortId, type Column } from '../output.js'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'name', header: 'NAME' },
  { key: 'transport', header: 'TRANSPORT' },
  { key: 'enabled', header: 'ENABLED', transform: (v) => (v ? 'yes' : 'no') },
]

export function registerMcpCommands(parent: Command): void {
  const mcp = parent
    .command('mcp')
    .description('Manage MCP servers')

  mcp
    .command('list')
    .description('List all MCP servers')
    .action(async () => {
      const { client, json } = createClient(parent)
      const data = await client.get<unknown>('/api/mcp-servers')
      printResult(data, json, COLUMNS)
    })

  mcp
    .command('show <id>')
    .description('Show an MCP server')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.get<unknown>(`/api/mcp-servers/${id}`)
      printResult(data, json, COLUMNS)
    })

  mcp
    .command('add')
    .description('Add an MCP server')
    .requiredOption('--name <name>', 'Server name')
    .requiredOption('--command <cmd>', 'Command to run')
    .option('--args <args>', 'Comma-separated arguments')
    .action(async (opts: { name: string; command: string; args?: string }) => {
      const { client, json } = createClient(parent)

      const body = {
        name: opts.name,
        transport: 'stdio',
        command: opts.command,
        args: opts.args ? opts.args.split(',') : [],
      }

      const data = await client.post<unknown>('/api/mcp-servers', body)
      printResult(data, json, COLUMNS)
    })

  mcp
    .command('import <file>')
    .description('Import MCP servers from a JSON file')
    .action(async (file: string) => {
      const { client, json } = createClient(parent)

      let fileContent: unknown
      try {
        const raw = readFileSync(file, 'utf-8')
        fileContent = JSON.parse(raw)
      } catch (error) {
        throw new Error(`Failed to read or parse file ${file}: ${error instanceof Error ? error.message : String(error)}`)
      }

      const data = await client.post<unknown>('/api/mcp-servers/import-json', fileContent)
      printResult(data, json)
    })

  mcp
    .command('delete <id>')
    .description('Delete an MCP server')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      await client.delete<unknown>(`/api/mcp-servers/${id}`)
      if (!json) {
        console.log(`MCP server ${shortId(id)} deleted.`)
      }
    })
}
