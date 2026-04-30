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
    .option('--git <url>', 'Git repository URL（GitHub）')
    .option('--skill-md-url <url>', 'GitHub raw SKILL.md URL（多 skill 仓库时显式指定要装的那个）')
    .option('--path <dir>', 'Local directory path（包含 SKILL.md）')
    .option('--overwrite', '同名 skill 已存在时覆盖', false)
    .action(async (opts: { git?: string; skillMdUrl?: string; path?: string; overwrite?: boolean }) => {
      const ctx = createContext(parent)

      if (opts.git || opts.skillMdUrl) {
        const gitUrl = opts.git
        const result = await runWrite({
          subcommand: 'skill add',
          args: gitUrl ? { '--git': gitUrl } : { '--skill-md-url': opts.skillMdUrl as string },
          command_text: gitUrl
            ? `skill add --git ${gitUrl}${opts.overwrite ? ' --overwrite' : ''}`
            : `skill add --skill-md-url ${opts.skillMdUrl}${opts.overwrite ? ' --overwrite' : ''}`,
          execute: async () => {
            // admin 协议：scan body {git_url}，返回 {skills: [{skill_md_url, ...}]}；install body {skill_md_url, source_git_url?, overwrite?}
            let skillMdUrl: string
            let sourceGitUrl: string | undefined
            if (opts.skillMdUrl) {
              skillMdUrl = opts.skillMdUrl
            } else {
              const scanResult = await ctx.client.post<{ skills: Array<{ skill_md_url: string; name: string; path: string }> }>(
                '/api/skills/import-git/scan',
                { git_url: gitUrl },
              )
              if (!scanResult.skills?.length) {
                throw new Error(`仓库 ${gitUrl} 内没有发现 SKILL.md`)
              }
              if (scanResult.skills.length > 1) {
                const candidates = scanResult.skills.map((s) => `  - ${s.name} (${s.skill_md_url})`).join('\n')
                throw new Error(
                  `仓库 ${gitUrl} 包含多个 skill，请用 --skill-md-url 指定要装的那个：\n${candidates}`
                )
              }
              skillMdUrl = scanResult.skills[0]!.skill_md_url
              sourceGitUrl = gitUrl
            }
            const installBody: Record<string, unknown> = { skill_md_url: skillMdUrl }
            if (sourceGitUrl) installBody['source_git_url'] = sourceGitUrl
            if (opts.overwrite) installBody['overwrite'] = true
            return ctx.client.post<unknown>('/api/skills/import-git/install', installBody)
          },
          reverseFromResult: (r) => {
            const newId = (r as { id?: string })?.id ?? '<unknown>'
            return {
              command: `skill delete ${newId}`,
              preview_description: `delete skill imported from git ${gitUrl ?? opts.skillMdUrl} (${newId})`,
            }
          },
          dataDir: ctx.dataDir,
          actor: ctx.actor,
          mode: ctx.mode,
        })
        renderResult(maskSensitive(result), { mode: ctx.mode })
      } else if (opts.path) {
        const localPath = opts.path
        const result = await runWrite({
          subcommand: 'skill add',
          args: { '--path': localPath },
          command_text: `skill add --path ${localPath}${opts.overwrite ? ' --overwrite' : ''}`,
          // admin 协议：{dir_path: string, overwrite?: boolean}（不是 {path}）
          execute: () => {
            const body: Record<string, unknown> = { dir_path: localPath }
            if (opts.overwrite) body['overwrite'] = true
            return ctx.client.post<unknown>('/api/skills/import-local', body)
          },
          reverseFromResult: (r) => {
            const newId = (r as { id?: string })?.id ?? '<unknown>'
            return {
              command: `skill delete ${newId}`,
              preview_description: `delete skill imported from path ${localPath} (${newId})`,
            }
          },
          dataDir: ctx.dataDir,
          actor: ctx.actor,
          mode: ctx.mode,
        })
        renderResult(maskSensitive(result), { mode: ctx.mode })
      } else {
        add.error('Either --git, --skill-md-url, or --path is required')
      }
    })

  skill
    .command('delete <ref>')
    .description('Delete a skill')
    .option('--confirm <token>', 'Confirmation token from preview response')
    .action(async (ref: string, opts: { confirm?: string }) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'skill', ref)
      const { args, command_text: cmdText } = buildDeleteParams('skill delete', ref, opts.confirm)
      const result = await runWrite({
        subcommand: 'skill delete',
        args,
        command_text: cmdText,
        execute: () => ctx.client.delete(`/api/skills/${id}`),
        collectPreview: async () => {
          const agents = await ctx.client.getList<{ id: string; name: string; skill_ids?: string[] }>('/api/agent-instances')
          const refs = agents
            .filter((a) => (a.skill_ids ?? []).includes(id))
            .map((a) => ({ id: a.id, name: a.name }))
          return {
            side_effects: refs.length > 0 ? [{ type: 'agent_unset', agents: refs }] : [],
            rollback_difficulty: '本地 path 导入的 skill 丢了 path 难找回；git 导入的需要重新拉',
          }
        },
        dataDir: ctx.dataDir,
        actor: ctx.actor,
        mode: ctx.mode,
      })
      renderResult(result, { mode: ctx.mode })
    })
}

