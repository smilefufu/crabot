import { Command } from 'commander'
import { createClient } from '../main.js'
import { printResult, shortId, type Column } from '../output.js'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'name', header: 'NAME' },
  { key: 'version', header: 'VERSION' },
  { key: 'is_builtin', header: 'BUILTIN', transform: (v) => (v ? 'yes' : 'no') },
  { key: 'enabled', header: 'ENABLED', transform: (v) => (v ? 'yes' : 'no') },
]

export function registerSkillCommands(parent: Command): void {
  const skill = parent
    .command('skill')
    .description('Manage skills')

  skill
    .command('list')
    .description('List all skills')
    .action(async () => {
      const { client, json } = createClient(parent)
      const data = await client.get<unknown>('/api/skills')
      printResult(data, json, COLUMNS)
    })

  skill
    .command('show <id>')
    .description('Show a skill')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.get<unknown>(`/api/skills/${id}`)
      printResult(data, json, COLUMNS)
    })

  const add = skill
    .command('add')
    .description('Add a skill from git or local path')
    .option('--git <url>', 'Git repository URL')
    .option('--path <dir>', 'Local directory path')
    .action(async (opts: { git?: string; path?: string }) => {
      const { client, json } = createClient(parent)

      if (opts.git) {
        const scanResult = await client.post<{ install_id?: string; [key: string]: unknown }>(
          '/api/skills/import-git/scan',
          { url: opts.git }
        )
        const data = await client.post<unknown>(
          '/api/skills/import-git/install',
          scanResult
        )
        printResult(data, json, COLUMNS)
      } else if (opts.path) {
        const data = await client.post<unknown>('/api/skills/import-local', {
          path: opts.path,
        })
        printResult(data, json, COLUMNS)
      } else {
        add.error('Either --git or --path is required')
      }
    })

  skill
    .command('delete <id>')
    .description('Delete a skill')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      await client.delete<unknown>(`/api/skills/${id}`)
      if (!json) {
        console.log(`Skill ${shortId(id)} deleted.`)
      }
    })
}
