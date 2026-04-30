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
  { key: 'display_name', header: 'NAME' },
  { key: 'permission', header: 'PERMISSION' },
]

const ALLOWED_PERMISSIONS = ['master', 'normal'] as const

export interface FriendAddOpts {
  readonly name: string
  readonly permission: string
  readonly permissionTemplate?: string
}

export interface FriendUpdateOpts {
  readonly name?: string
  readonly permission?: string
  readonly permissionTemplate?: string
}

/**
 * 构造 admin POST /api/friends 的请求体（CreateFriendParams）。
 * admin 协议要求 display_name + permission（master|normal）必填；
 * permission_template_id 在 normal 时通常需要（admin handler fallback 'standard'）。
 */
export function buildCreateFriendBody(opts: FriendAddOpts): Record<string, unknown> {
  const body: Record<string, unknown> = {
    display_name: assertNonEmpty('--name', opts.name),
    permission: assertEnum('--permission', opts.permission, ALLOWED_PERMISSIONS),
  }
  if (opts.permissionTemplate?.trim()) body['permission_template_id'] = opts.permissionTemplate.trim()
  return body
}

/**
 * 构造 admin PATCH /api/friends/:id 的请求体（UpdateFriendParams 不含 friend_id）。
 * 至少一个可选字段必须提供（避免空 PATCH）。
 */
export function buildUpdateFriendBody(opts: FriendUpdateOpts): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (opts.name?.trim()) body['display_name'] = opts.name.trim()
  if (opts.permission) body['permission'] = assertEnum('--permission', opts.permission, ALLOWED_PERMISSIONS)
  if (opts.permissionTemplate?.trim()) body['permission_template_id'] = opts.permissionTemplate.trim()
  if (Object.keys(body).length === 0) {
    throw new CliError('INVALID_ARGUMENT', '至少需要提供 --name / --permission / --permission-template 其中一个')
  }
  return body
}

export function registerFriendCommands(parent: Command): void {
  const friend = parent.command('friend').description('Manage friends')

  friend
    .command('list')
    .description('List all friends')
    .option('--search <keyword>', 'Search by keyword')
    .action(async (opts: { search?: string }) => {
      const ctx = createContext(parent)
      const query = opts.search ? `?search=${encodeURIComponent(opts.search)}` : ''
      const data = await ctx.client.get<unknown>(`/api/friends${query}`)
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  friend
    .command('show <ref>')
    .description('Show a friend')
    .action(async (ref: string) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'friend', ref)
      const data = await ctx.client.get<unknown>(`/api/friends/${id}`)
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  friend
    .command('add')
    .description('Add a friend')
    .requiredOption('--name <name>', 'Friend display name')
    .requiredOption('--permission <permission>', `Friend permission (${ALLOWED_PERMISSIONS.join('|')})`)
    .option('--permission-template <templateId>', 'Permission template ID（normal 通常需要，缺省 fallback 到 standard）')
    .action(async (opts: FriendAddOpts) => {
      const ctx = createContext(parent)
      const body = buildCreateFriendBody(opts)

      const cmdParts = [
        'friend add',
        `--name ${JSON.stringify(opts.name)}`,
        `--permission ${opts.permission}`,
      ]
      if (opts.permissionTemplate) cmdParts.push(`--permission-template ${opts.permissionTemplate}`)

      const result = await runWrite({
        subcommand: 'friend add',
        args: { '--name': opts.name, '--permission': opts.permission },
        command_text: cmdParts.join(' '),
        execute: () => ctx.client.post('/api/friends', body),
        reverseFromResult: (r) => {
          const newId = extractCreatedId(r, 'friend')
          return {
            command: `friend delete ${newId}`,
            preview_description: `delete friend ${opts.name} (${newId})`,
          }
        },
        dataDir: ctx.dataDir,
        actor: ctx.actor,
        mode: ctx.mode,
      })
      renderResult(maskSensitive(result), { mode: ctx.mode })
    })

  friend
    .command('update <ref>')
    .description('Update a friend')
    .option('--name <name>', 'Friend display name')
    .option('--permission <permission>', `Friend permission (${ALLOWED_PERMISSIONS.join('|')})`)
    .option('--permission-template <templateId>', 'Permission template ID')
    .option('--confirm <token>', 'Confirmation token from preview response')
    .action(async (ref: string, opts: FriendUpdateOpts & { confirm?: string }) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'friend', ref)
      const body = buildUpdateFriendBody(opts)

      // admin GET 返回 { friend: Friend }；PATCH 接受 flat UpdateFriendParams。snapshot 必须 unwrap 后再存，
      // 否则 undo --restore-snapshot 时 PATCH body 是 {friend:{...}}，admin 读不到字段。
      const before = await ctx.client.getUnwrap<Record<string, unknown>>(`/api/friends/${id}`, 'friend')
      const args: Record<string, unknown> = { _positional: ref }
      if (opts.confirm) args['--confirm'] = opts.confirm

      const setParts: string[] = []
      if (opts.name) setParts.push(`--name ${JSON.stringify(opts.name)}`)
      if (opts.permission) setParts.push(`--permission ${opts.permission}`)
      if (opts.permissionTemplate) setParts.push(`--permission-template ${opts.permissionTemplate}`)
      const cmdText = opts.confirm
        ? `friend update ${ref} ${setParts.join(' ')} --confirm ${opts.confirm}`
        : `friend update ${ref} ${setParts.join(' ')}`

      const result = await runWrite({
        subcommand: 'friend update',
        args,
        command_text: cmdText,
        execute: () => ctx.client.patch(`/api/friends/${id}`, body),
        reverse: {
          command: `friend update ${ref} --restore-snapshot`,
          preview_description: `restore friend ${ref} to snapshot taken before this change`,
        },
        snapshot: before,
        dataDir: ctx.dataDir,
        actor: ctx.actor,
        mode: ctx.mode,
      })
      renderResult(maskSensitive(result), { mode: ctx.mode })
    })

  friend
    .command('delete <ref>')
    .description('Delete a friend')
    .option('--confirm <token>', 'Confirmation token from preview response')
    .action(async (ref: string, opts: { confirm?: string }) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'friend', ref)
      const { args, command_text: cmdText } = buildDeleteParams('friend delete', ref, opts.confirm)

      const result = await runWrite({
        subcommand: 'friend delete',
        args,
        command_text: cmdText,
        execute: () => ctx.client.delete(`/api/friends/${id}`),
        collectPreview: async () => {
          const friend = await ctx.client.get<{ id: string; channel_identities?: unknown[] }>(
            `/api/friends/${id}`,
          )
          const ids = friend.channel_identities ?? []
          return {
            side_effects: [{ type: 'cascade_identity_delete', count: ids.length }],
            rollback_difficulty: '关联的 channel identity 一并 cascade 删除，无法整体恢复',
          }
        },
        dataDir: ctx.dataDir,
        actor: ctx.actor,
        mode: ctx.mode,
      })
      renderResult(result, { mode: ctx.mode })
    })
}
