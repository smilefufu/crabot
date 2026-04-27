import { Command } from 'commander'
import { createContext } from '../main.js'
import { renderResult, type Column, shortId } from '../output.js'
import { resolveRef } from '../resolve.js'
import { maskSensitive } from '../mask.js'
import { runWrite } from '../run-write.js'
import { buildDeleteParams } from './_utils.js'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'name', header: 'NAME' },
  { key: 'permission', header: 'PERMISSION' },
]

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
    .requiredOption('--name <name>', 'Friend name')
    .option('--permission <templateId>', 'Permission template ID')
    .action(async (opts: { name: string; permission?: string }) => {
      const ctx = createContext(parent)

      const body: Record<string, unknown> = { name: opts.name }
      if (opts.permission) {
        body['permission_template_id'] = opts.permission
      }

      const result = await runWrite({
        subcommand: 'friend add',
        args: { '--name': opts.name },
        command_text: `friend add --name ${opts.name}${opts.permission ? ` --permission ${opts.permission}` : ''}`,
        execute: () => ctx.client.post('/api/friends', body),
        reverseFromResult: (r) => {
          const newId = (r as { id?: string })?.id ?? '<unknown>'
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
    .option('--name <name>', 'Friend name')
    .option('--permission <templateId>', 'Permission template ID')
    .option('--confirm <token>', 'Confirmation token from preview response')
    .action(async (ref: string, opts: { name?: string; permission?: string; confirm?: string }) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'friend', ref)

      const body: Record<string, unknown> = {}
      if (opts.name) body['name'] = opts.name
      if (opts.permission) body['permission_template_id'] = opts.permission

      const before = await ctx.client.get<unknown>(`/api/friends/${id}`)
      const args: Record<string, unknown> = { _positional: ref }
      if (opts.confirm) args['--confirm'] = opts.confirm

      const setParts: string[] = []
      if (opts.name) setParts.push(`--name ${opts.name}`)
      if (opts.permission) setParts.push(`--permission ${opts.permission}`)
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
