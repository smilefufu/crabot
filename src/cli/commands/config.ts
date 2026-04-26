import { Command } from 'commander'
import { createContext } from '../main.js'
import { renderResult } from '../output.js'
import { maskSensitive } from '../mask.js'
import { runWrite } from '../run-write.js'
import { parseKeyValuePairs } from './_utils.js'

export function registerConfigCommands(parent: Command): void {
  const config = parent.command('config').description('Manage global configuration')

  config
    .command('show')
    .description('Show global model config and proxy config')
    .action(async () => {
      const ctx = createContext(parent)
      const [modelConfig, proxyConfig] = await Promise.all([
        ctx.client.get<unknown>('/api/model-config/global'),
        ctx.client.get<unknown>('/api/proxy-config'),
      ])
      renderResult(maskSensitive({ model_config: modelConfig, proxy_config: proxyConfig }), {
        mode: ctx.mode,
      })
    })

  config
    .command('set <pairs...>')
    .description('Set global model config values (key=value)')
    .option('--confirm <token>', 'Confirmation token from preview response')
    .action(async (pairs: string[], opts: { confirm?: string }) => {
      const ctx = createContext(parent)

      const body = parseKeyValuePairs(pairs)
      const before = await ctx.client.get<unknown>('/api/model-config/global')
      const args: Record<string, unknown> = { _positional: pairs.join(' ') }
      if (opts.confirm) args['--confirm'] = opts.confirm

      const pairsText = pairs.join(' ')
      const cmdText = opts.confirm
        ? `config set ${pairsText} --confirm ${opts.confirm}`
        : `config set ${pairsText}`

      const result = await runWrite({
        subcommand: 'config set',
        args,
        command_text: cmdText,
        execute: () => ctx.client.patch('/api/model-config/global', body),
        reverse: {
          command: 'config restore-snapshot',
          preview_description: 'restore global config to snapshot taken before this change',
        },
        snapshot: before,
        dataDir: ctx.dataDir,
        actor: process.env['CRABOT_ACTOR'] ?? 'human',
      })
      renderResult(maskSensitive(result), { mode: ctx.mode })
    })

  const proxy = config.command('proxy').description('Manage proxy configuration')

  proxy
    .command('show')
    .description('Show proxy config')
    .action(async () => {
      const ctx = createContext(parent)
      const data = await ctx.client.get<unknown>('/api/proxy-config')
      renderResult(maskSensitive(data), { mode: ctx.mode })
    })

  proxy
    .command('set <pair>')
    .description('Set a proxy config value (key=value)')
    .option('--confirm <token>', 'Confirmation token from preview response')
    .action(async (pair: string, opts: { confirm?: string }) => {
      const ctx = createContext(parent)

      const body = parseKeyValuePairs([pair])
      const before = await ctx.client.get<unknown>('/api/proxy-config')
      const args: Record<string, unknown> = { _positional: pair }
      if (opts.confirm) args['--confirm'] = opts.confirm

      const cmdText = opts.confirm
        ? `config proxy set ${pair} --confirm ${opts.confirm}`
        : `config proxy set ${pair}`

      const result = await runWrite({
        subcommand: 'config proxy set',
        args,
        command_text: cmdText,
        execute: () => ctx.client.patch('/api/proxy-config', body),
        reverse: {
          command: 'config proxy restore-snapshot',
          preview_description: 'restore proxy config to snapshot taken before this change',
        },
        snapshot: before,
        dataDir: ctx.dataDir,
        actor: process.env['CRABOT_ACTOR'] ?? 'human',
      })
      renderResult(maskSensitive(result), { mode: ctx.mode })
    })
}
