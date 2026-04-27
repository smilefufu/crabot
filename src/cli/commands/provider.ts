import { Command } from 'commander'
import { createContext } from '../main.js'
import { renderResult, type Column, shortId } from '../output.js'
import { resolveRef } from '../resolve.js'
import { maskSensitive } from '../mask.js'
import { runWrite } from '../run-write.js'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'name', header: 'NAME' },
  { key: 'type', header: 'TYPE' },
]

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8').trim()
}

export function registerProviderCommands(parent: Command): void {
  const provider = parent.command('provider').description('Manage model providers')

  provider
    .command('list')
    .description('List all providers')
    .action(async () => {
      const ctx = createContext(parent)
      const data = await ctx.client.get<unknown>('/api/model-providers')
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  provider
    .command('show <ref>')
    .description('Show a provider')
    .action(async (ref: string) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'provider', ref)
      const data = await ctx.client.get<unknown>(`/api/model-providers/${id}`)
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  provider
    .command('add')
    .description('Add a provider')
    .requiredOption('--name <name>', 'Provider name')
    .requiredOption('--type <type>', 'Provider type')
    .requiredOption('--endpoint <url>', 'Provider endpoint URL')
    .option('--apikey <key>', 'API key')
    .option('--apikey-stdin', 'Read API key from stdin')
    .action(
      async (opts: {
        name: string
        type: string
        endpoint: string
        apikey?: string
        apikeyStdin?: boolean
      }) => {
        const ctx = createContext(parent)
        const apikey = opts.apikeyStdin ? await readStdin() : (opts.apikey ?? '')
        const body = { name: opts.name, type: opts.type, endpoint: opts.endpoint, apikey }
        const result = await runWrite({
          subcommand: 'provider add',
          args: { '--name': opts.name, '--type': opts.type, '--endpoint': opts.endpoint },
          command_text: `provider add --name ${opts.name} --type ${opts.type} --endpoint ${opts.endpoint} --apikey ${apikey}`,
          execute: () => ctx.client.post('/api/model-providers', body),
          reverseFromResult: (r) => {
            const newId = (r as { id?: string })?.id ?? '<unknown>'
            return {
              command: `provider delete ${newId}`,
              preview_description: `delete provider ${opts.name} (${newId})`,
            }
          },
          dataDir: ctx.dataDir,
          actor: process.env['CRABOT_ACTOR'] ?? 'human',
          mode: ctx.mode,
        })
        renderResult(maskSensitive(result), { mode: ctx.mode })
      },
    )

  provider
    .command('test <ref>')
    .description('Test a provider connection')
    .action(async (ref: string) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'provider', ref)
      const data = await ctx.client.post<unknown>(`/api/model-providers/${id}/test`)
      renderResult(data, { mode: ctx.mode })
    })

  provider
    .command('refresh <ref>')
    .description('Refresh provider models')
    .action(async (ref: string) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'provider', ref)
      const data = await ctx.client.post<unknown>(`/api/model-providers/${id}/refresh-models`)
      renderResult(data, { mode: ctx.mode })
    })

  provider
    .command('delete <ref>')
    .description('Delete a provider')
    .option('--confirm <token>', 'Confirmation token from preview response')
    .action(async (ref: string, opts: { confirm?: string }) => {
      const ctx = createContext(parent)
      const { id, name } = await resolveRef(ctx.client, 'provider', ref)
      const args: Record<string, unknown> = { _positional: ref }
      if (opts.confirm) args['--confirm'] = opts.confirm
      const cmdText = opts.confirm
        ? `provider delete ${ref} --confirm ${opts.confirm}`
        : `provider delete ${ref}`
      const result = await runWrite({
        subcommand: 'provider delete',
        args,
        command_text: cmdText,
        execute: () => ctx.client.delete(`/api/model-providers/${id}`),
        collectPreview: async () => {
          const agents = await ctx.client.get<Array<{ id: string; name: string; models?: unknown }>>(
            '/api/agent-instances',
          )
          const referencing = agents
            .filter((a) => JSON.stringify(a.models ?? {}).includes(id))
            .map((a) => ({ id: a.id, name: a.name }))
          const sideEffects: unknown[] = []
          if (referencing.length > 0)
            sideEffects.push({ type: 'agent_unset', agents: referencing })
          return {
            side_effects: sideEffects,
            rollback_difficulty: '需重新粘贴 apikey 原文',
          }
        },
        dataDir: ctx.dataDir,
        actor: process.env['CRABOT_ACTOR'] ?? 'human',
        mode: ctx.mode,
      })
      // name is resolved above — suppress the unused warning by referencing it
      void name
      renderResult(result, { mode: ctx.mode })
    })
}
