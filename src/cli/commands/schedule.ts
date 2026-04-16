import { Command } from 'commander'
import { createClient } from '../main.js'
import { printResult, shortId, type Column } from '../output.js'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'title', header: 'TITLE' },
  { key: 'trigger_type', header: 'TRIGGER' },
  { key: 'action', header: 'ACTION' },
  { key: 'enabled', header: 'ENABLED', transform: (v) => (v ? 'yes' : 'no') },
]

export function registerScheduleCommands(parent: Command): void {
  const schedule = parent
    .command('schedule')
    .description('Manage schedules')

  schedule
    .command('list')
    .description('List all schedules')
    .action(async () => {
      const { client, json } = createClient(parent)
      const data = await client.get<unknown>('/api/schedules')
      printResult(data, json, COLUMNS)
    })

  schedule
    .command('show <id>')
    .description('Show a schedule')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.get<unknown>(`/api/schedules/${id}`)
      printResult(data, json, COLUMNS)
    })

  const add = schedule
    .command('add')
    .description('Add a schedule')
    .requiredOption('--title <title>', 'Schedule title')
    .requiredOption('--action <action>', 'Action to perform')
    .option('--cron <expr>', 'Cron expression (for cron triggers)')
    .option('--trigger-at <time>', 'Trigger time (for once triggers)')
    .option('--target-channel <id>', 'Target channel instance ID')
    .option('--target-session <id>', 'Target session ID')
    .action(async (opts: {
      title: string
      action: string
      cron?: string
      triggerAt?: string
      targetChannel?: string
      targetSession?: string
    }) => {
      const { client, json } = createClient(parent)

      if (!opts.cron && !opts.triggerAt) {
        add.error('Either --cron or --trigger-at is required')
      }

      const body: Record<string, unknown> = {
        title: opts.title,
        action: opts.action,
      }

      if (opts.cron) {
        body['trigger_type'] = 'cron'
        body['cron'] = opts.cron
      } else if (opts.triggerAt) {
        body['trigger_type'] = 'once'
        body['trigger_at'] = opts.triggerAt
      }

      if (opts.targetChannel) {
        body['target_channel_instance_id'] = opts.targetChannel
      }

      if (opts.targetSession) {
        body['target_session_id'] = opts.targetSession
      }

      const data = await client.post<unknown>('/api/schedules', body)
      printResult(data, json, COLUMNS)
    })

  schedule
    .command('trigger <id>')
    .description('Manually trigger a schedule')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.post<unknown>(`/api/schedules/${id}/trigger`)
      printResult(data, json)
    })

  schedule
    .command('delete <id>')
    .description('Delete a schedule')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      await client.delete<unknown>(`/api/schedules/${id}`)
      if (!json) {
        console.log(`Schedule ${shortId(id)} deleted.`)
      }
    })
}
