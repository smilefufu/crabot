import { Command } from 'commander'
import { createContext } from '../main.js'
import { renderResult, type Column, shortId } from '../output.js'
import { resolveRef } from '../resolve.js'
import { maskSensitive } from '../mask.js'
import { runWrite } from '../run-write.js'
import { buildDeleteParams } from './_utils.js'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'title', header: 'TITLE' },
  { key: 'trigger_type', header: 'TRIGGER' },
  { key: 'action', header: 'ACTION' },
  { key: 'enabled', header: 'ENABLED', transform: (v) => (v ? 'yes' : 'no') },
]

export function registerScheduleCommands(parent: Command): void {
  const schedule = parent.command('schedule').description('Manage schedules')

  schedule
    .command('list')
    .description('List all schedules')
    .action(async () => {
      const ctx = createContext(parent)
      const data = await ctx.client.get<unknown>('/api/schedules')
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  schedule
    .command('show <ref>')
    .description('Show a schedule')
    .action(async (ref: string) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'schedule', ref)
      const data = await ctx.client.get<unknown>(`/api/schedules/${id}`)
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
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
    .action(
      async (opts: {
        title: string
        action: string
        cron?: string
        triggerAt?: string
        targetChannel?: string
        targetSession?: string
      }) => {
        const ctx = createContext(parent)

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

        const result = await runWrite({
          subcommand: 'schedule add',
          args: { '--title': opts.title, '--action': opts.action },
          command_text: `schedule add --title ${opts.title} --action ${opts.action}`,
          execute: () => ctx.client.post('/api/schedules', body),
          reverseFromResult: (r) => {
            const newId = (r as { id?: string })?.id ?? '<unknown>'
            return {
              command: `schedule delete ${newId}`,
              preview_description: `delete schedule "${opts.title}" (${newId})`,
            }
          },
          dataDir: ctx.dataDir,
          actor: ctx.actor,
          mode: ctx.mode,
        })
        renderResult(maskSensitive(result), { mode: ctx.mode })
      },
    )

  schedule
    .command('trigger <ref>')
    .description('Manually trigger a schedule')
    .option('--confirm <token>', 'Confirmation token from preview response')
    .action(async (ref: string, opts: { confirm?: string }) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'schedule', ref)
      const { args, command_text: cmdText } = buildDeleteParams('schedule trigger', ref, opts.confirm)
      const result = await runWrite({
        subcommand: 'schedule trigger',
        args,
        command_text: cmdText,
        execute: () => ctx.client.post(`/api/schedules/${id}/trigger`),
        collectPreview: async () => ({
          side_effects: [
            {
              type: 'external_side_effect',
              description:
                '触发的副作用（消息已发、API 已调）已经离开 Crabot 边界，无法 rollback',
            },
          ],
          rollback_difficulty: '触发产生的副作用无法撤销',
        }),
        dataDir: ctx.dataDir,
        actor: ctx.actor,
        mode: ctx.mode,
      })
      renderResult(result, { mode: ctx.mode })
    })

  schedule
    .command('delete <ref>')
    .description('Delete a schedule')
    .option('--confirm <token>', 'Confirmation token from preview response')
    .action(async (ref: string, opts: { confirm?: string }) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'schedule', ref)
      const args: Record<string, unknown> = { _positional: ref }
      if (opts.confirm) args['--confirm'] = opts.confirm
      const cmdText = opts.confirm
        ? `schedule delete ${ref} --confirm ${opts.confirm}`
        : `schedule delete ${ref}`
      const result = await runWrite({
        subcommand: 'schedule delete',
        args,
        command_text: cmdText,
        execute: () => ctx.client.delete(`/api/schedules/${id}`),
        collectPreview: async () => ({
          side_effects: [
            {
              type: 'config_lost',
              description: 'cron + action 配置丢失',
            },
          ],
          rollback_difficulty: 'cron + action 配置丢失，需要重新添加',
        }),
        dataDir: ctx.dataDir,
        actor: ctx.actor,
        mode: ctx.mode,
      })
      renderResult(result, { mode: ctx.mode })
    })
}
