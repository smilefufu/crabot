import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { createContext } from '../main.js'
import { renderResult, type Column, shortId } from '../output.js'
import { resolveRef } from '../resolve.js'
import { maskSensitive } from '../mask.js'
import { runWrite } from '../run-write.js'
import { buildDeleteParams } from './_utils.js'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'name', header: 'NAME' },
  { key: 'transport', header: 'TRANSPORT' },
  { key: 'enabled', header: 'ENABLED', transform: (v) => (v ? 'yes' : 'no') },
]

export function registerMcpCommands(parent: Command): void {
  const mcp = parent.command('mcp').description('Manage MCP servers')

  mcp
    .command('list')
    .description('List all MCP servers')
    .action(async () => {
      const ctx = createContext(parent)
      const data = await ctx.client.get<unknown>('/api/mcp-servers')
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  mcp
    .command('show <ref>')
    .description('Show an MCP server')
    .action(async (ref: string) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'mcp', ref)
      const data = await ctx.client.get<unknown>(`/api/mcp-servers/${id}`)
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  mcp
    .command('add')
    .description('Add an MCP server')
    .requiredOption('--name <name>', 'Server name')
    .requiredOption('--command <cmd>', 'Command to run')
    .option('--args <args>', 'Comma-separated arguments')
    .action(async (opts: { name: string; command: string; args?: string }) => {
      const ctx = createContext(parent)
      const body = {
        name: opts.name,
        transport: 'stdio',
        command: opts.command,
        args: opts.args ? opts.args.split(',') : [],
      }
      const result = await runWrite({
        subcommand: 'mcp add',
        args: { '--name': opts.name, '--command': opts.command },
        command_text: `mcp add --name ${opts.name} --command ${opts.command}${opts.args ? ` --args ${opts.args}` : ''}`,
        execute: () => ctx.client.post('/api/mcp-servers', body),
        reverseFromResult: (r) => {
          const newId = (r as { id?: string })?.id ?? '<unknown>'
          return {
            command: `mcp delete ${newId}`,
            preview_description: `delete MCP server ${opts.name} (${newId})`,
          }
        },
        dataDir: ctx.dataDir,
        actor: ctx.actor,
        mode: ctx.mode,
      })
      renderResult(maskSensitive(result), { mode: ctx.mode })
    })

  mcp
    .command('import <file>')
    .description('Import MCP servers from a JSON file')
    .action(async (file: string) => {
      const ctx = createContext(parent)

      // admin handler 期望 body 是 { json: string }（自己负责 parse），不是 parse 好的对象
      const fileContent = readFileSync(file, 'utf-8')

      const result = await runWrite({
        subcommand: 'mcp import',
        args: { _positional: file },
        command_text: `mcp import ${file}`,
        execute: () => ctx.client.post('/api/mcp-servers/import-json', { json: fileContent }),
        reverseFromResult: (r) => {
          // admin 返回 { entries: [...], count: N }
          const result = r as { entries?: Array<{ id?: string }> }
          const ids = (result.entries ?? []).map((e) => e.id ?? '').filter(Boolean)
          const idList = ids.join(',')
          return {
            command: `mcp undo-import ${idList}`,
            preview_description: `delete ${ids.length} MCP server${ids.length !== 1 ? 's' : ''} imported from ${file}`,
          }
        },
        dataDir: ctx.dataDir,
        actor: ctx.actor,
        mode: ctx.mode,
      })
      renderResult(maskSensitive(result), { mode: ctx.mode })
    })

  mcp
    .command('delete <ref>')
    .description('Delete an MCP server')
    .option('--confirm <token>', 'Confirmation token from preview response')
    .action(async (ref: string, opts: { confirm?: string }) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'mcp', ref)
      const { args, command_text: cmdText } = buildDeleteParams('mcp delete', ref, opts.confirm)
      const result = await runWrite({
        subcommand: 'mcp delete',
        args,
        command_text: cmdText,
        execute: () => ctx.client.delete(`/api/mcp-servers/${id}`),
        collectPreview: async () => {
          const agents = await ctx.client.getList<{ id: string; name: string; mcp_ids?: string[] }>('/api/agent-instances')
          const refs = agents
            .filter((a) => (a.mcp_ids ?? []).includes(id))
            .map((a) => ({ id: a.id, name: a.name }))
          return {
            side_effects: refs.length > 0 ? [{ type: 'agent_unset', agents: refs }] : [],
            rollback_difficulty: 'mcp 配置可能复杂，重建容易出错',
          }
        },
        dataDir: ctx.dataDir,
        actor: ctx.actor,
        mode: ctx.mode,
      })
      renderResult(result, { mode: ctx.mode })
    })
}
