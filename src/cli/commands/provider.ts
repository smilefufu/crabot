import { Command } from 'commander'
import { createContext } from '../main.js'
import { renderResult, type Column, shortId } from '../output.js'
import { resolveRef } from '../resolve.js'
import { maskSensitive } from '../mask.js'
import { runWrite } from '../run-write.js'
import { assertEnum, assertNonEmpty, buildDeleteParams, extractCreatedId } from './_utils.js'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'name', header: 'NAME' },
  { key: 'type', header: 'TYPE' },
  { key: 'format', header: 'FORMAT' },
]

const ALLOWED_TYPES = ['manual', 'preset'] as const
const ALLOWED_FORMATS = ['openai', 'anthropic', 'gemini', 'openai-responses'] as const

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8').trim()
}

export interface ProviderAddOpts {
  readonly name: string
  readonly format: string
  readonly endpoint: string
  readonly type?: string
  readonly apikey?: string
  readonly presetVendor?: string
}

/**
 * 构造 admin POST /api/model-providers 的请求体（CreateModelProviderParams）。
 * admin 协议要求 name/type/format/endpoint/api_key/models 都必填；models 创建时给空数组，
 * 由 `provider refresh <id>` 后续填充。
 */
export function buildCreateProviderBody(opts: ProviderAddOpts): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: assertNonEmpty('--name', opts.name),
    type: assertEnum('--type', opts.type?.trim() || 'manual', ALLOWED_TYPES),
    format: assertEnum('--format', opts.format, ALLOWED_FORMATS),
    endpoint: assertNonEmpty('--endpoint', opts.endpoint),
    api_key: (opts.apikey ?? '').trim(),
    models: [],
  }
  if (opts.presetVendor?.trim()) body['preset_vendor'] = opts.presetVendor.trim()
  return body
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
    .description('Add a provider (创建后用 `provider refresh <id>` 拉取模型列表)')
    .requiredOption('--name <name>', 'Provider name')
    .requiredOption('--format <format>', `API format (${ALLOWED_FORMATS.join('|')})`)
    .requiredOption('--endpoint <url>', 'Provider endpoint URL')
    .option('--type <type>', `Config type (${ALLOWED_TYPES.join('|')}, 默认 manual)`)
    .option('--apikey <key>', 'API key')
    .option('--apikey-stdin', 'Read API key from stdin')
    .option('--preset-vendor <id>', 'Preset vendor id（仅 type=preset 用）')
    .action(
      async (opts: ProviderAddOpts & { apikeyStdin?: boolean }) => {
        const ctx = createContext(parent)
        const apikey = opts.apikeyStdin ? await readStdin() : (opts.apikey ?? '')
        const body = buildCreateProviderBody({ ...opts, apikey })

        const cmdParts = [
          'provider add',
          `--name ${JSON.stringify(opts.name)}`,
          `--format ${opts.format}`,
          `--endpoint ${JSON.stringify(opts.endpoint)}`,
        ]
        if (opts.type) cmdParts.push(`--type ${opts.type}`)
        if (apikey) cmdParts.push('--apikey ***')

        const result = await runWrite({
          subcommand: 'provider add',
          args: { '--name': opts.name, '--format': opts.format, '--endpoint': opts.endpoint },
          command_text: cmdParts.join(' '),
          execute: () => ctx.client.post('/api/model-providers', body),
          reverseFromResult: (r) => {
            const newId = extractCreatedId(r)
            return {
              command: `provider delete ${newId}`,
              preview_description: `delete provider ${opts.name} (${newId})`,
            }
          },
          dataDir: ctx.dataDir,
          actor: ctx.actor,
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
      const { id } = await resolveRef(ctx.client, 'provider', ref)
      const { args, command_text: cmdText } = buildDeleteParams('provider delete', ref, opts.confirm)
      const result = await runWrite({
        subcommand: 'provider delete',
        args,
        command_text: cmdText,
        execute: () => ctx.client.delete(`/api/model-providers/${id}`),
        collectPreview: async () => {
          const agents = await ctx.client.getList<{ id: string; name: string; model_config?: unknown }>('/api/agent-instances')
          const referencing = agents
            .filter((a) => JSON.stringify(a.model_config ?? {}).includes(id))
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
        actor: ctx.actor,
        mode: ctx.mode,
      })
      renderResult(result, { mode: ctx.mode })
    })
}
