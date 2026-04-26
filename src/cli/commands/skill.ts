import { Command } from 'commander'
import { createContext } from '../main.js'
import { renderResult, type Column, shortId } from '../output.js'
import { resolveRef } from '../resolve.js'
import { maskSensitive } from '../mask.js'
import { runWrite } from '../run-write.js'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'name', header: 'NAME' },
  { key: 'version', header: 'VERSION' },
  { key: 'is_builtin', header: 'BUILTIN', transform: (v) => (v ? 'yes' : 'no') },
  { key: 'enabled', header: 'ENABLED', transform: (v) => (v ? 'yes' : 'no') },
]

export function registerSkillCommands(parent: Command): void {
  const skill = parent.command('skill').description('Manage skills')

  skill
    .command('list')
    .description('List all skills')
    .action(async () => {
      const ctx = createContext(parent)
      const data = await ctx.client.get<unknown>('/api/skills')
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  skill
    .command('show <ref>')
    .description('Show a skill')
    .action(async (ref: string) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'skill', ref)
      const data = await ctx.client.get<unknown>(`/api/skills/${id}`)
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  const add = skill
    .command('add')
    .description('Add a skill from git or local path')
    .option('--git <url>', 'Git repository URL')
    .option('--path <dir>', 'Local directory path')
    .action(async (opts: { git?: string; path?: string }) => {
      const ctx = createContext(parent)

      if (opts.git) {
        const gitUrl = opts.git
        const result = await runWrite({
          subcommand: 'skill add',
          args: { '--git': gitUrl },
          command_text: `skill add --git ${gitUrl}`,
          execute: async () => {
            const scanResult = await ctx.client.post<{ install_id?: string; [key: string]: unknown }>(
              '/api/skills/import-git/scan',
              { url: gitUrl },
            )
            return ctx.client.post<unknown>('/api/skills/import-git/install', scanResult)
          },
          reverseFromResult: (r) => {
            const newId = (r as { id?: string })?.id ?? '<unknown>'
            return {
              command: `skill delete ${newId}`,
              preview_description: `delete skill imported from git ${gitUrl} (${newId})`,
            }
          },
          dataDir: ctx.dataDir,
          actor: process.env['CRABOT_ACTOR'] ?? 'human',
        })
        renderResult(maskSensitive(result), { mode: ctx.mode })
      } else if (opts.path) {
        const localPath = opts.path
        const result = await runWrite({
          subcommand: 'skill add',
          args: { '--path': localPath },
          command_text: `skill add --path ${localPath}`,
          execute: () => ctx.client.post<unknown>('/api/skills/import-local', { path: localPath }),
          reverseFromResult: (r) => {
            const newId = (r as { id?: string })?.id ?? '<unknown>'
            return {
              command: `skill delete ${newId}`,
              preview_description: `delete skill imported from path ${localPath} (${newId})`,
            }
          },
          dataDir: ctx.dataDir,
          actor: process.env['CRABOT_ACTOR'] ?? 'human',
        })
        renderResult(maskSensitive(result), { mode: ctx.mode })
      } else {
        add.error('Either --git or --path is required')
      }
    })

  skill
    .command('delete <ref>')
    .description('Delete a skill')
    .option('--confirm <token>', 'Confirmation token from preview response')
    .action(async (ref: string, opts: { confirm?: string }) => {
      const ctx = createContext(parent)
      const { id, name } = await resolveRef(ctx.client, 'skill', ref)
      const args: Record<string, unknown> = { _positional: ref }
      if (opts.confirm) args['--confirm'] = opts.confirm
      const cmdText = opts.confirm
        ? `skill delete ${ref} --confirm ${opts.confirm}`
        : `skill delete ${ref}`
      const result = await runWrite({
        subcommand: 'skill delete',
        args,
        command_text: cmdText,
        execute: () => ctx.client.delete(`/api/skills/${id}`),
        collectPreview: async () => {
          const agents = await ctx.client.get<
            Array<{ id: string; name: string; skill_ids?: string[] }>
          >('/api/agent-instances')
          const refs = agents
            .filter((a) => (a.skill_ids ?? []).includes(id))
            .map((a) => ({ id: a.id, name: a.name }))
          return {
            side_effects: refs.length > 0 ? [{ type: 'agent_unset', agents: refs }] : [],
            rollback_difficulty: '本地 path 导入的 skill 丢了 path 难找回；git 导入的需要重新拉',
          }
        },
        dataDir: ctx.dataDir,
        actor: process.env['CRABOT_ACTOR'] ?? 'human',
      })
      void name
      renderResult(result, { mode: ctx.mode })
    })
}

