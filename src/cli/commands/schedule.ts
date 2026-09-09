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
  readonly title?: string
  readonly priority?: string
  readonly script?: string
  readonly timeoutSeconds?: string
  readonly deliverResult?: string
  readonly name?: string
  readonly description?: string
  readonly taskDescription?: string
  readonly taskType?: string
  readonly tag?: ReadonlyArray<string>
  readonly cron?: string
  readonly triggerAt?: string
  readonly intervalSeconds?: string
  readonly timezone?: string
  readonly targetChannel?: string
  readonly targetSession?: string
  readonly targetType?: string
  readonly disabled?: boolean
}

/**
 * 本地最小 schedule 类型：仅含 buildUpdateScheduleBody 实际读取的字段。
 * 不 import crabot-admin/src/types 以保持 CLI 类型独立性（CLI 与 admin 通过 REST body
 * 通信，admin 协议变化时 CLI 这里编译挂不挂自行决定）。
 */
export interface ScheduleSnapshot {
  readonly trigger:
    | { readonly type: 'cron'; readonly expression: string; readonly timezone?: string }
    | { readonly type: 'interval'; readonly seconds: number }
    | { readonly type: 'once'; readonly execute_at: string }
  readonly task_template?: {
    readonly title: string
    readonly priority: string
    readonly description?: string
    readonly type?: string
    readonly tags: readonly string[]
  }
  readonly script?: {
    readonly source?: string
    readonly timeout_seconds: number
    readonly deliver_result: boolean
    readonly source_sha256: string
  }
}

export interface ScheduleUpdateOpts {
  readonly name?: string
  readonly description?: string
  readonly enabled?: string                  // commander 给 string，函数内 parse

  // trigger 字段级（同类型内）
  readonly cron?: string
  readonly timezone?: string
  readonly intervalSeconds?: string
  readonly triggerAt?: string

  // task_template 字段级
  readonly title?: string
  readonly taskDescription?: string
  readonly taskPriority?: string
  readonly taskType?: string
  readonly tag?: ReadonlyArray<string>
  readonly clearTags?: boolean
  readonly script?: string
  readonly timeoutSeconds?: string
  readonly deliverResult?: string
}

/**
 * 把 CLI 选项翻译成 admin 协议（CreateScheduleParams）的请求体。
 * 拆出来是为了：单测独立 + 协议字段映射集中在一处。
 * 不合法时抛 CliError('INVALID_ARGUMENT', ...) — 走 main.ts 顶层 catch。
 */
export function buildCreateScheduleBody(opts: ScheduleAddOpts): Record<string, unknown> {
  const scriptMode = opts.script !== undefined
  const title = scriptMode ? undefined : assertNonEmpty('--title', opts.title)
  const priority = scriptMode ? undefined : assertEnum('--priority', opts.priority, ALLOWED_PRIORITIES)
  const triggerFlagCount = [opts.cron, opts.intervalSeconds, opts.triggerAt].filter(Boolean).length
  if (triggerFlagCount === 0) {
    throw new CliError(
      'INVALID_ARGUMENT',
      '必须提供 --cron / --interval-seconds / --trigger-at 其中一个',
    )
  }
  if (triggerFlagCount > 1) {
    throw new CliError(
      'INVALID_ARGUMENT',
      '--cron / --interval-seconds / --trigger-at 三者互斥，只能提供一个',
    )
  }

  let trigger: Record<string, unknown>
  if (opts.cron) {
    const expression = opts.cron.trim()
    if (expression.split(/\s+/).length < 5) {
      throw new CliError(
        'INVALID_ARGUMENT',
        `--cron 表达式无效: "${expression}"，至少需要 5 个字段（分 时 日 月 周）`,
      )
    }
    trigger = {
      type: 'cron',
      expression,
      timezone: opts.timezone?.trim() || 'Asia/Shanghai',
    }
  } else if (opts.intervalSeconds) {
    const seconds = Number(opts.intervalSeconds)
    if (!Number.isInteger(seconds) || seconds < 1) {
      throw new CliError(
        'INVALID_ARGUMENT',
        `--interval-seconds 必须是正整数，得到 "${opts.intervalSeconds}"`,
      )
    }
    trigger = { type: 'interval', seconds }
  } else {
    const raw = opts.triggerAt as string
    if (Number.isNaN(new Date(raw).getTime())) {
      throw new CliError(
        'INVALID_ARGUMENT',
        `--trigger-at 格式无效: "${raw}"，请使用 ISO 8601 格式，如 2026-04-15T16:45:00+08:00`,
      )
    }
    trigger = { type: 'once', execute_at: new Date(raw).toISOString() }
  }

  const content: Record<string, unknown> = {}
  if (scriptMode) {
    const source = assertNonEmpty('--script', opts.script)
    const timeout = opts.timeoutSeconds === undefined ? undefined : Number(opts.timeoutSeconds)
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 600)) {
      throw new CliError('INVALID_ARGUMENT', '--timeout-seconds 必须是 1 到 600 的整数')
    }
    if (opts.deliverResult !== undefined && opts.deliverResult !== 'true' && opts.deliverResult !== 'false') {
      throw new CliError('INVALID_ARGUMENT', '--deliver-result 必须是 true 或 false')
    }
    content['script'] = {
      source,
      ...(timeout === undefined ? {} : { timeout_seconds: timeout }),
      ...(opts.deliverResult === undefined ? {} : { deliver_result: opts.deliverResult === 'true' }),
    }
  } else {
    const taskTemplate: Record<string, unknown> = {
      title,
      priority,
      tags: opts.tag ? [...opts.tag] : [],
    }
    if (opts.taskType?.trim()) taskTemplate['type'] = opts.taskType.trim()
    if (opts.taskDescription?.trim()) taskTemplate['description'] = opts.taskDescription.trim()
    content['task_template'] = taskTemplate
  }
  const hasAnyTarget = !!(opts.targetChannel || opts.targetSession || opts.targetType)
  const hasAllTarget = !!(opts.targetChannel && opts.targetSession && opts.targetType)
  if (hasAnyTarget && !hasAllTarget) {
    throw new CliError(
      'INVALID_ARGUMENT',
      '--target-channel / --target-session / --target-type 必须同时提供（要么三个都给，要么都不给）',
    )
  }

  const body: Record<string, unknown> = {
    name: opts.name?.trim() || title,
    trigger,
    ...content,
    enabled: !opts.disabled,
  }
  if (opts.description?.trim()) body['description'] = opts.description.trim()

  if (hasAllTarget) {
    const type = assertEnum('--target-type', opts.targetType, ['private', 'group'] as const)
    body['target_session'] = {
      channel_id: opts.targetChannel,
      session_id: opts.targetSession,
      type,
    }
  }

  if (!body['name']) throw new CliError('INVALID_ARGUMENT', '脚本 Schedule 必须提供 --name')

  return body
}

const ALLOWED_TARGET_TYPES = ['private', 'group'] as const

/**
 * 构造 admin PATCH /api/schedules/:id 的请求体（UpdateScheduleParams 不含 schedule_id）。
 *
 * 字段语义：
 * - 顶层标量（name/description/enabled）：opts 给了 → 写；没给 → key 不出现
 * - trigger：opts 任一 trigger flag 给了 → current.trigger 作底字段级 merge 后输出完整
 *   trigger 对象（admin 协议整体替换）；都没给 → 不写。跨类型修改报错。
 * - task_template：opts 任一 template flag 给了 → current.task_template 作底字段级 merge
 *   后输出完整对象；都没给 → 不写。tags 用 --tag 覆盖原 tags（不追加），--clear-tags 清空。
 * - target_session：--clear-target → null；三个 target-* 都给 → 对象；都没给 → 不写。
 *
 * 至少一个修改 flag 必给，否则报 INVALID_ARGUMENT（避免空 PATCH）。
 */
export function buildUpdateScheduleBody(
  current: ScheduleSnapshot,
  opts: ScheduleUpdateOpts,
): Record<string, unknown> {
  const body: Record<string, unknown> = {}

  // 顶层标量
  if (opts.name?.trim()) body['name'] = opts.name.trim()
  if (opts.description !== undefined) body['description'] = opts.description.trim()
  if (opts.enabled !== undefined) {
    if (opts.enabled !== 'true' && opts.enabled !== 'false') {
      throw new CliError(
        'INVALID_ARGUMENT',
        `--enabled 必须是 true | false，收到: "${opts.enabled}"`,
      )
    }
    body['enabled'] = opts.enabled === 'true'
  }

  // trigger 字段级 merge（同类型内更新）
  const triggerOptKeys = {
    cron: !!opts.cron,
    timezone: opts.timezone !== undefined,
    intervalSeconds: !!opts.intervalSeconds,
    triggerAt: !!opts.triggerAt,
  }
  const hasTriggerOpt = Object.values(triggerOptKeys).some(Boolean)
  if (hasTriggerOpt) {
    const ct = current.trigger
    // 跨类型校验：每个 flag 仅适用于一种 type
    if ((triggerOptKeys.cron || triggerOptKeys.timezone) && ct.type !== 'cron') {
      const flag = triggerOptKeys.cron ? '--cron' : '--timezone'
      throw new CliError(
        'INVALID_ARGUMENT',
        `当前 schedule 是 ${ct.type} 类型，${flag} 仅适用于 cron 类型；如需切换类型请走 admin web 或 delete+add`,
      )
    }
    if (triggerOptKeys.intervalSeconds && ct.type !== 'interval') {
      throw new CliError(
        'INVALID_ARGUMENT',
        `当前 schedule 是 ${ct.type} 类型，--interval-seconds 仅适用于 interval 类型；如需切换类型请走 admin web 或 delete+add`,
      )
    }
    if (triggerOptKeys.triggerAt && ct.type !== 'once') {
      throw new CliError(
        'INVALID_ARGUMENT',
        `当前 schedule 是 ${ct.type} 类型，--trigger-at 仅适用于 once 类型；如需切换类型请走 admin web 或 delete+add`,
      )
    }

    if (ct.type === 'cron') {
      const expression = opts.cron?.trim() ?? ct.expression
      if (expression.split(/\s+/).length < 5) {
        throw new CliError(
          'INVALID_ARGUMENT',
          `--cron 表达式无效: "${expression}"，至少需要 5 个字段（分 时 日 月 周）`,
        )
      }
      const timezone = opts.timezone !== undefined ? (opts.timezone.trim() || 'Asia/Shanghai') : ct.timezone
      body['trigger'] = { type: 'cron', expression, timezone }
    } else if (ct.type === 'interval') {
      const seconds = Number(opts.intervalSeconds)
      if (!Number.isInteger(seconds) || seconds < 1) {
        throw new CliError(
          'INVALID_ARGUMENT',
          `--interval-seconds 必须是正整数，得到 "${opts.intervalSeconds}"`,
        )
      }
      body['trigger'] = { type: 'interval', seconds }
    } else {
      // ct.type === 'once'
      const raw = opts.triggerAt as string
      if (Number.isNaN(new Date(raw).getTime())) {
        throw new CliError(
          'INVALID_ARGUMENT',
          `--trigger-at 格式无效: "${raw}"，请使用 ISO 8601 格式，如 2026-04-15T16:45:00+08:00`,
        )
      }
      body['trigger'] = { type: 'once', execute_at: new Date(raw).toISOString() }
    }
  }

  // task_template 字段级 merge（CLI 内部 GET + merge，绕开 admin 整体替换）
  const templateOptKeys = {
    title: !!opts.title?.trim(),
    description: opts.taskDescription !== undefined,
    priority: !!opts.taskPriority,
    type: opts.taskType !== undefined,
    tag: !!opts.tag,
    clearTags: !!opts.clearTags,
  }
  const hasTemplateOpt = Object.values(templateOptKeys).some(Boolean)
  if (hasTemplateOpt) {
    if (templateOptKeys.tag && templateOptKeys.clearTags) {
      throw new CliError('INVALID_ARGUMENT', '--tag 与 --clear-tags 互斥')
    }

    const base = current.task_template
    if (!base && !opts.title?.trim()) {
      throw new CliError('INVALID_ARGUMENT', '从脚本切换为 instruction 时必须提供 --title')
    }
    const tt = base
      ? { ...base, tags: [...base.tags] }
      : { title: opts.title!.trim(), priority: 'normal', tags: [] as string[] }
    if (opts.title?.trim()) tt.title = opts.title.trim()
    if (opts.taskDescription !== undefined) tt.description = opts.taskDescription.trim()
    if (opts.taskPriority) {
      tt.priority = assertEnum('--task-priority', opts.taskPriority, ALLOWED_PRIORITIES)
    }
    if (opts.taskType !== undefined) tt.type = opts.taskType.trim()
    if (opts.tag) tt.tags = [...opts.tag]
    if (opts.clearTags) tt.tags = []
    body['task_template'] = tt
    if (current.script) body['script'] = null
  }

  const hasScriptOpt = opts.script !== undefined || opts.timeoutSeconds !== undefined || opts.deliverResult !== undefined
  if (hasScriptOpt) {
    if (hasTemplateOpt) throw new CliError('INVALID_ARGUMENT', 'instruction 与 script 修改不能同时提供')
    const source = opts.script ?? current.script?.source
    if (!source) throw new CliError('INVALID_ARGUMENT', '修改脚本配置时必须能读取现有 source 或提供 --script')
    const timeout = opts.timeoutSeconds === undefined
      ? current.script?.timeout_seconds
      : Number(opts.timeoutSeconds)
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 600)) {
      throw new CliError('INVALID_ARGUMENT', '--timeout-seconds 必须是 1 到 600 的整数')
    }
    if (opts.deliverResult !== undefined && opts.deliverResult !== 'true' && opts.deliverResult !== 'false') {
      throw new CliError('INVALID_ARGUMENT', '--deliver-result 必须是 true 或 false')
    }
    body['script'] = {
      source: assertNonEmpty('--script', source),
      ...(timeout === undefined ? {} : { timeout_seconds: timeout }),
      deliver_result: opts.deliverResult === undefined
        ? current.script?.deliver_result ?? false
        : opts.deliverResult === 'true',
    }
    if (current.task_template) body['task_template'] = null
  }

  if (Object.keys(body).length === 0) {
    throw new CliError(
      'INVALID_ARGUMENT',
      '至少需要提供一个修改字段',
    )
  }
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
      const data = await ctx.client.get<unknown>(`/api/schedules/${id}?include_script_source=true`)
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  schedule
    .command('add')
    .description('Add a schedule')
    .option('--title <title>', 'Instruction title（与 --script 二选一）')
    .option('--priority <priority>', `Instruction priority (${ALLOWED_PRIORITIES.join('|')})`)
    .option('--script <source>', 'Inline Bash source（与 --title 二选一）')
    .option('--timeout-seconds <n>', 'Script timeout，1-600 秒')
    .option('--deliver-result <true|false>', '是否把脚本结果投递给目标 Manager')
    .option('--name <name>', 'Schedule 名称（不传则 fallback 到 --title）')
    .option('--description <desc>', 'Schedule 描述（人读层面，给 master 看）')
    .option('--task-description <desc>', 'Task 描述（任务触发时给 LLM 的 prompt）')
    .option('--task-type <type>', 'Task 类型，用于 trace 过滤（如 daily_reflection）')
    .option('--tag <tag>', 'Task 标签（可重复 --tag a --tag b）', collectTag)
    .option('--cron <expr>', 'Cron 表达式（5 字段：分 时 日 月 周）')
    .option('--interval-seconds <n>', '定时间隔秒数（interval 触发器；与 --cron / --trigger-at 三者互斥）')
    .option('--trigger-at <time>', 'ISO 8601 触发时间（一次性触发器）')
    .option('--timezone <tz>', 'Cron 时区（默认 Asia/Shanghai）')
    .option('--target-channel <id>', '触发目标 channel instance id（写入顶层 target_session.channel_id）')
    .option('--target-session <id>', '触发目标 session id（写入顶层 target_session.session_id）')
    .option('--target-type <type>', '目标 session 类型（private|group；三个 target-* flag 必须同时提供）')
    .option('--disabled', '创建时禁用（默认启用）')
    .action(async (opts: ScheduleAddOpts) => {
      const ctx = createContext(parent)
      const body = buildCreateScheduleBody(opts)

      const cmdParts = [
        'schedule add',
      ]
      if (opts.title) cmdParts.push(`--title ${JSON.stringify(opts.title)}`)
      if (opts.priority) cmdParts.push(`--priority ${opts.priority}`)
      if (opts.script !== undefined) cmdParts.push('--script [redacted]')
      if (opts.name) cmdParts.push(`--name ${JSON.stringify(opts.name)}`)
      if (opts.cron) cmdParts.push(`--cron ${JSON.stringify(opts.cron)}`)
      if (opts.intervalSeconds) cmdParts.push(`--interval-seconds ${opts.intervalSeconds}`)
      if (opts.triggerAt) cmdParts.push(`--trigger-at ${JSON.stringify(opts.triggerAt)}`)
      if (opts.targetChannel) cmdParts.push(`--target-channel ${opts.targetChannel}`)
      if (opts.targetSession) cmdParts.push(`--target-session ${opts.targetSession}`)
      if (opts.targetType) cmdParts.push(`--target-type ${opts.targetType}`)

      const result = await runWrite({
        subcommand: 'schedule add',
        args: opts.script === undefined
          ? { '--title': opts.title, '--priority': opts.priority }
          : { '--script': '[redacted]' },
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
    .command('update <ref>')
    .description('Update a schedule')
    .option('--name <name>', 'Schedule 名称')
    .option('--description <desc>', 'Schedule 描述（人读层面）')
    .option('--enabled <true|false>', '启用状态')
    .option('--cron <expr>', 'Cron 表达式（仅 cron 类型 schedule）')
    .option('--timezone <tz>', 'Cron 时区（仅 cron 类型 schedule）')
    .option('--interval-seconds <n>', '定时间隔秒数（仅 interval 类型 schedule）')
    .option('--trigger-at <time>', 'ISO 8601 触发时间（仅 once 类型 schedule）')
    .option('--title <title>', 'Task template title')
    .option('--task-description <desc>', 'Task 描述')
    .option('--task-priority <p>', `Task 优先级 (${ALLOWED_PRIORITIES.join('|')})`)
    .option('--task-type <type>', 'Task 类型')
    .option('--tag <tag>', 'Task 标签（覆盖原 tags；可重复 --tag a --tag b）', collectTag)
    .option('--clear-tags', '清空 task tags')
    .option('--script <source>', '替换为 inline Bash 或更新 source')
    .option('--timeout-seconds <n>', 'Script timeout，1-600 秒')
    .option('--deliver-result <true|false>', '是否把脚本结果投递给目标 Manager')
    .option('--confirm <token>', 'Confirmation token from preview response')
    .action(async (ref: string, opts: ScheduleUpdateOpts & { confirm?: string }) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'schedule', ref)

      // GET snapshot — admin GET 响应 { schedule: Schedule }，unwrap 后既是 PATCH body 的合法形态。
      // 用 ScheduleSnapshot 局部类型断言（CLI 不 import admin 协议类型）。
      const before = await ctx.client.getUnwrap<ScheduleSnapshot & Record<string, unknown>>(
        `/api/schedules/${id}`,
        'schedule',
      )

      const needsScriptSource = before.script
        && (opts.script !== undefined || opts.timeoutSeconds !== undefined || opts.deliverResult !== undefined)
      const current = needsScriptSource
        ? await ctx.client.getUnwrap<ScheduleSnapshot & Record<string, unknown>>(
            `/api/schedules/${id}?include_script_source=true`, 'schedule',
          )
        : before

      const body = buildUpdateScheduleBody(current, opts)

      const args: Record<string, unknown> = { _positional: ref }
      if (opts.confirm) args['--confirm'] = opts.confirm

      const setParts: string[] = []
      if (opts.name) setParts.push(`--name ${JSON.stringify(opts.name)}`)
      if (opts.description !== undefined) setParts.push(`--description ${JSON.stringify(opts.description)}`)
      if (opts.enabled) setParts.push(`--enabled ${opts.enabled}`)
      if (opts.cron) setParts.push(`--cron ${JSON.stringify(opts.cron)}`)
      if (opts.timezone) setParts.push(`--timezone ${opts.timezone}`)
      if (opts.intervalSeconds) setParts.push(`--interval-seconds ${opts.intervalSeconds}`)
      if (opts.triggerAt) setParts.push(`--trigger-at ${JSON.stringify(opts.triggerAt)}`)
      if (opts.title) setParts.push(`--title ${JSON.stringify(opts.title)}`)
      if (opts.taskDescription !== undefined) setParts.push(`--task-description ${JSON.stringify(opts.taskDescription)}`)
      if (opts.taskPriority) setParts.push(`--task-priority ${opts.taskPriority}`)
      if (opts.taskType !== undefined) setParts.push(`--task-type ${JSON.stringify(opts.taskType)}`)
      if (opts.tag) for (const t of opts.tag) setParts.push(`--tag ${JSON.stringify(t)}`)
      if (opts.clearTags) setParts.push('--clear-tags')
      if (opts.script !== undefined) setParts.push('--script [redacted]')
      if (opts.timeoutSeconds !== undefined) setParts.push(`--timeout-seconds ${opts.timeoutSeconds}`)
      if (opts.deliverResult) setParts.push('--deliver-result')
      const cmdText = opts.confirm
        ? `schedule update ${ref} ${setParts.join(' ')} --confirm ${opts.confirm}`
        : `schedule update ${ref} ${setParts.join(' ')}`

      const result = await runWrite({
        subcommand: 'schedule update',
        args,
        command_text: cmdText,
        execute: () => ctx.client.patch(`/api/schedules/${id}`, body),
        reverse: {
          command: `schedule update ${ref} --restore-snapshot`,
          preview_description: `restore schedule ${ref} to snapshot taken before this change`,
        },
        snapshot: before,
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
