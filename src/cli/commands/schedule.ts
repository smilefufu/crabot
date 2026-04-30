import { Command } from 'commander'
import { createContext } from '../main.js'
import { CliError } from '../errors.js'
import { renderResult, type Column, shortId } from '../output.js'
import { resolveRef } from '../resolve.js'
import { maskSensitive } from '../mask.js'
import { runWrite } from '../run-write.js'
import { assertEnum, assertNonEmpty, buildDeleteParams, extractCreatedId } from './_utils.js'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'name', header: 'NAME' },
  { key: 'trigger.type', header: 'TRIGGER' },
  { key: 'enabled', header: 'ENABLED', transform: (v) => (v ? 'yes' : 'no') },
]

const ALLOWED_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

export interface ScheduleAddOpts {
  readonly title: string
  readonly priority: string
  readonly name?: string
  readonly description?: string
  readonly taskDescription?: string
  readonly taskType?: string
  readonly tag?: ReadonlyArray<string>
  readonly cron?: string
  readonly triggerAt?: string
  readonly timezone?: string
  readonly targetChannel?: string
  readonly targetSession?: string
  readonly disabled?: boolean
}

/**
 * 把 CLI 选项翻译成 admin 协议（CreateScheduleParams）的请求体。
 * 拆出来是为了：单测独立 + 协议字段映射集中在一处。
 * 不合法时抛 CliError('INVALID_ARGUMENT', ...) — 走 main.ts 顶层 catch。
 */
export function buildCreateScheduleBody(opts: ScheduleAddOpts): Record<string, unknown> {
  const title = assertNonEmpty('--title', opts.title)
  const priority = assertEnum('--priority', opts.priority, ALLOWED_PRIORITIES)
  if (!opts.cron && !opts.triggerAt) {
    throw new CliError('INVALID_ARGUMENT', '必须提供 --cron（周期性）或 --trigger-at（一次性），不能都为空')
  }
  if (opts.cron && opts.triggerAt) {
    throw new CliError('INVALID_ARGUMENT', '--cron 和 --trigger-at 互斥，不能同时提供')
  }

  let trigger: Record<string, unknown>
  if (opts.cron) {
    const expression = opts.cron.trim()
    if (expression.split(/\s+/).length < 5) {
      throw new CliError('INVALID_ARGUMENT', `--cron 表达式无效: "${expression}"，至少需要 5 个字段（分 时 日 月 周）`)
    }
    trigger = {
      type: 'cron',
      expression,
      timezone: opts.timezone?.trim() || 'Asia/Shanghai',
    }
  } else {
    const raw = opts.triggerAt as string
    if (Number.isNaN(new Date(raw).getTime())) {
      throw new CliError('INVALID_ARGUMENT', `--trigger-at 格式无效: "${raw}"，请使用 ISO 8601 格式，如 2026-04-15T16:45:00+08:00`)
    }
    trigger = { type: 'once', execute_at: new Date(raw).toISOString() }
  }

  const taskTemplate: Record<string, unknown> = {
    title,
    priority,
    tags: opts.tag ? [...opts.tag] : [],
  }
  if (opts.taskType?.trim()) taskTemplate['type'] = opts.taskType.trim()
  if (opts.taskDescription?.trim()) taskTemplate['description'] = opts.taskDescription.trim()
  if (opts.targetChannel || opts.targetSession) {
    const input: Record<string, unknown> = {}
    if (opts.targetChannel) input['target_channel_id'] = opts.targetChannel
    if (opts.targetSession) input['target_session_id'] = opts.targetSession
    taskTemplate['input'] = input
  }

  const body: Record<string, unknown> = {
    name: opts.name?.trim() || title,
    trigger,
    task_template: taskTemplate,
    enabled: !opts.disabled,
  }
  if (opts.description?.trim()) body['description'] = opts.description.trim()
  return body
}

function collectTag(value: string, prev: string[] = []): string[] {
  return [...prev, value]
}

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

  schedule
    .command('add')
    .description('Add a schedule')
    .requiredOption('--title <title>', 'Task template title (会作为触发任务的标题，可含 {{date}}/{{datetime}} 占位符)')
    .requiredOption('--priority <priority>', `Task priority (${ALLOWED_PRIORITIES.join('|')})`)
    .option('--name <name>', 'Schedule 名称（不传则 fallback 到 --title）')
    .option('--description <desc>', 'Schedule 描述（人读层面，给 master 看）')
    .option('--task-description <desc>', 'Task 描述（任务触发时给 LLM 的 prompt）')
    .option('--task-type <type>', 'Task 类型，用于 trace 过滤（如 daily_reflection）')
    .option('--tag <tag>', 'Task 标签（可重复 --tag a --tag b）', collectTag)
    .option('--cron <expr>', 'Cron 表达式（5 字段：分 时 日 月 周）')
    .option('--trigger-at <time>', 'ISO 8601 触发时间（一次性触发器）')
    .option('--timezone <tz>', 'Cron 时区（默认 Asia/Shanghai）')
    .option('--target-channel <id>', '触发目标 channel instance id（写入 task_template.input.target_channel_id）')
    .option('--target-session <id>', '触发目标 session id（写入 task_template.input.target_session_id）')
    .option('--disabled', '创建时禁用（默认启用）')
    .action(async (opts: ScheduleAddOpts) => {
      const ctx = createContext(parent)
      const body = buildCreateScheduleBody(opts)

      const cmdParts = [
        'schedule add',
        `--title ${JSON.stringify(opts.title)}`,
        `--priority ${opts.priority}`,
      ]
      if (opts.name) cmdParts.push(`--name ${JSON.stringify(opts.name)}`)
      if (opts.cron) cmdParts.push(`--cron ${JSON.stringify(opts.cron)}`)
      if (opts.triggerAt) cmdParts.push(`--trigger-at ${JSON.stringify(opts.triggerAt)}`)

      const result = await runWrite({
        subcommand: 'schedule add',
        args: { '--title': opts.title, '--priority': opts.priority },
        command_text: cmdParts.join(' '),
        execute: () => ctx.client.post('/api/schedules', body),
        reverseFromResult: (r) => {
          const newId = extractCreatedId(r, 'schedule')
          return {
            command: `schedule delete ${newId}`,
            preview_description: `delete schedule "${opts.name ?? opts.title}" (${newId})`,
          }
        },
        dataDir: ctx.dataDir,
        actor: ctx.actor,
        mode: ctx.mode,
      })
      renderResult(maskSensitive(result), { mode: ctx.mode })
    })

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
