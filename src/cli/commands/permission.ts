import { Command } from 'commander'
import { createContext } from '../main.js'
import { renderResult, type Column, shortId } from '../output.js'
import { resolveRef } from '../resolve.js'
import { maskSensitive } from '../mask.js'
import { runWrite } from '../run-write.js'
import { buildDeleteParams, readJsonFile } from './_utils.js'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'name', header: 'NAME' },
  { key: 'is_system', header: 'SYSTEM', transform: (v) => (v ? 'yes' : 'no') },
]

export function registerPermissionCommands(parent: Command): void {
  const permission = parent.command('permission').description('Manage permission templates')

  permission
    .command('list')
    .description('List all permission templates')
    .action(async () => {
      const ctx = createContext(parent)
      const data = await ctx.client.get<unknown>('/api/permission-templates')
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  permission
    .command('show <ref>')
    .description('Show a permission template')
    .action(async (ref: string) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'permission', ref)
      const data = await ctx.client.get<unknown>(`/api/permission-templates/${id}`)
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  permission
    .command('add')
    .description('Add a permission template')
    .requiredOption('--name <name>', 'Template name')
    .requiredOption('--file <json>', 'Path to JSON file with template definition')
    .action(async (opts: { name: string; file: string }) => {
      const ctx = createContext(parent)

      const templateData = readJsonFile(opts.file)
      const body = {
        name: opts.name,
        ...(typeof templateData === 'object' && templateData !== null ? templateData : {}),
      }

      const result = await runWrite({
        subcommand: 'permission add',
        args: { '--name': opts.name, '--file': opts.file },
        command_text: `permission add --name ${opts.name} --file ${opts.file}`,
        execute: () => ctx.client.post('/api/permission-templates', body),
        reverseFromResult: (r) => {
          const newId = (r as { id?: string })?.id ?? '<unknown>'
          return {
            command: `permission delete ${newId}`,
            preview_description: `delete permission template ${opts.name} (${newId})`,
          }
        },
        dataDir: ctx.dataDir,
        actor: ctx.actor,
        mode: ctx.mode,
      })
      renderResult(maskSensitive(result), { mode: ctx.mode })
    })

  permission
    .command('update <ref>')
    .description('Update a permission template')
    .option('--name <name>', 'Template name')
    .option('--file <json>', 'Path to JSON file with template definition')
    .option('--confirm <token>', 'Confirmation token from preview response')
    .action(
      async (ref: string, opts: { name?: string; file?: string; confirm?: string }) => {
        const ctx = createContext(parent)
        const { id } = await resolveRef(ctx.client, 'permission', ref)

        const body: Record<string, unknown> = {}
        if (opts.name) body['name'] = opts.name

        if (opts.file) {
          const templateData = readJsonFile(opts.file)
          if (typeof templateData === 'object' && templateData !== null) {
            Object.assign(body, templateData)
          }
        }

        // admin GET 返回 { template: ... }（wrap）；PATCH 接受 flat。snapshot 必须 unwrap。
        const before = await ctx.client.getUnwrap<Record<string, unknown>>(`/api/permission-templates/${id}`, 'template')
        const args: Record<string, unknown> = { _positional: ref }
        if (opts.confirm) args['--confirm'] = opts.confirm

        const setParts: string[] = []
        if (opts.name) setParts.push(`--name ${opts.name}`)
        if (opts.file) setParts.push(`--file ${opts.file}`)
        const cmdText = opts.confirm
          ? `permission update ${ref} ${setParts.join(' ')} --confirm ${opts.confirm}`
          : `permission update ${ref} ${setParts.join(' ')}`

        const result = await runWrite({
          subcommand: 'permission update',
          args,
          command_text: cmdText,
          execute: () => ctx.client.patch(`/api/permission-templates/${id}`, body),
          reverse: {
            command: `permission update ${ref} --restore-snapshot`,
            preview_description: `restore permission template ${ref} to snapshot taken before this change`,
          },
          snapshot: before,
          dataDir: ctx.dataDir,
          actor: ctx.actor,
          mode: ctx.mode,
        })
        renderResult(maskSensitive(result), { mode: ctx.mode })
      },
    )

  permission
    .command('delete <ref>')
    .description('Delete a permission template')
    .option('--confirm <token>', 'Confirmation token from preview response')
    .action(async (ref: string, opts: { confirm?: string }) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'permission', ref)
      const { args, command_text: cmdText } = buildDeleteParams('permission delete', ref, opts.confirm)

      const result = await runWrite({
        subcommand: 'permission delete',
        args,
        command_text: cmdText,
        execute: () => ctx.client.delete(`/api/permission-templates/${id}`),
        collectPreview: async () => {
          const friends = await ctx.client.getList<{ id: string; name: string; permission_template_id?: string }>('/api/friends')
          const refs = friends
            .filter((f) => f.permission_template_id === id)
            .map((f) => ({ id: f.id, name: f.name }))
          return {
            side_effects:
              refs.length > 0 ? [{ type: 'friend_unset', friends: refs }] : [],
            rollback_difficulty: '自定义模板 JSON 内容丢失',
          }
        },
        dataDir: ctx.dataDir,
        actor: ctx.actor,
        mode: ctx.mode,
      })
      renderResult(result, { mode: ctx.mode })
    })
}
