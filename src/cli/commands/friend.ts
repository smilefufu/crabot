import { Command } from 'commander'
import { createClient } from '../main.js'
import { printResult, shortId, type Column } from '../output.js'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'name', header: 'NAME' },
  { key: 'permission', header: 'PERMISSION' },
]

export function registerFriendCommands(parent: Command): void {
  const friend = parent
    .command('friend')
    .description('Manage friends')

  friend
    .command('list')
    .description('List all friends')
    .option('--search <keyword>', 'Search by keyword')
    .action(async (opts: { search?: string }) => {
      const { client, json } = createClient(parent)
      const query = opts.search ? `?search=${encodeURIComponent(opts.search)}` : ''
      const data = await client.get<unknown>(`/api/friends${query}`)
      printResult(data, json, COLUMNS)
    })

  friend
    .command('show <id>')
    .description('Show a friend')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.get<unknown>(`/api/friends/${id}`)
      printResult(data, json, COLUMNS)
    })

  friend
    .command('add')
    .description('Add a friend')
    .requiredOption('--name <name>', 'Friend name')
    .option('--permission <templateId>', 'Permission template ID')
    .action(async (opts: { name: string; permission?: string }) => {
      const { client, json } = createClient(parent)

      const body: Record<string, unknown> = {
        name: opts.name,
      }

      if (opts.permission) {
        body['permission_template_id'] = opts.permission
      }

      const data = await client.post<unknown>('/api/friends', body)
      printResult(data, json, COLUMNS)
    })

  friend
    .command('update <id>')
    .description('Update a friend')
    .option('--name <name>', 'Friend name')
    .option('--permission <templateId>', 'Permission template ID')
    .action(async (id: string, opts: { name?: string; permission?: string }) => {
      const { client, json } = createClient(parent)

      const body: Record<string, unknown> = {}

      if (opts.name) {
        body['name'] = opts.name
      }

      if (opts.permission) {
        body['permission_template_id'] = opts.permission
      }

      const data = await client.patch<unknown>(`/api/friends/${id}`, body)
      printResult(data, json, COLUMNS)
    })

  friend
    .command('delete <id>')
    .description('Delete a friend')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      await client.delete<unknown>(`/api/friends/${id}`)
      if (!json) {
        console.log(`Friend ${shortId(id)} deleted.`)
      }
    })
}
