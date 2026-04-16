import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { createClient } from '../main.js'
import { printResult, shortId, type Column } from '../output.js'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'name', header: 'NAME' },
  { key: 'is_system', header: 'SYSTEM', transform: (v) => (v ? 'yes' : 'no') },
]

export function registerPermissionCommands(parent: Command): void {
  const permission = parent
    .command('permission')
    .description('Manage permission templates')

  permission
    .command('list')
    .description('List all permission templates')
    .action(async () => {
      const { client, json } = createClient(parent)
      const data = await client.get<unknown>('/api/permission-templates')
      printResult(data, json, COLUMNS)
    })

  permission
    .command('show <id>')
    .description('Show a permission template')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.get<unknown>(`/api/permission-templates/${id}`)
      printResult(data, json, COLUMNS)
    })

  permission
    .command('add')
    .description('Add a permission template')
    .requiredOption('--name <name>', 'Template name')
    .requiredOption('--file <json>', 'Path to JSON file with template definition')
    .action(async (opts: { name: string; file: string }) => {
      const { client, json } = createClient(parent)

      let templateData: unknown
      try {
        const raw = readFileSync(opts.file, 'utf-8')
        templateData = JSON.parse(raw)
      } catch (error) {
        throw new Error(`Failed to read or parse file ${opts.file}: ${error instanceof Error ? error.message : String(error)}`)
      }

      const body = {
        name: opts.name,
        ...(typeof templateData === 'object' && templateData !== null ? templateData : {}),
      }

      const data = await client.post<unknown>('/api/permission-templates', body)
      printResult(data, json, COLUMNS)
    })

  permission
    .command('update <id>')
    .description('Update a permission template')
    .option('--name <name>', 'Template name')
    .option('--file <json>', 'Path to JSON file with template definition')
    .action(async (id: string, opts: { name?: string; file?: string }) => {
      const { client, json } = createClient(parent)

      const body: Record<string, unknown> = {}

      if (opts.name) {
        body['name'] = opts.name
      }

      if (opts.file) {
        let templateData: unknown
        try {
          const raw = readFileSync(opts.file, 'utf-8')
          templateData = JSON.parse(raw)
        } catch (error) {
          throw new Error(`Failed to read or parse file ${opts.file}: ${error instanceof Error ? error.message : String(error)}`)
        }

        if (typeof templateData === 'object' && templateData !== null) {
          Object.assign(body, templateData)
        }
      }

      const data = await client.patch<unknown>(`/api/permission-templates/${id}`, body)
      printResult(data, json, COLUMNS)
    })

  permission
    .command('delete <id>')
    .description('Delete a permission template')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      await client.delete<unknown>(`/api/permission-templates/${id}`)
      if (!json) {
        console.log(`Permission template ${shortId(id)} deleted.`)
      }
    })
}
