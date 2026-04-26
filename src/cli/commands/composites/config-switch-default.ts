import { Command } from 'commander'
import { createContext } from '../../main.js'
import { renderResult } from '../../output.js'
import { resolveRef } from '../../resolve.js'
import { runWrite } from '../../run-write.js'

export function registerConfigSwitchDefaultCommand(parent: Command): void {
  const configCmd = parent.commands.find(c => c.name() === 'config')
  if (!configCmd) throw new Error('config command must be registered first')

  configCmd
    .command('switch-default')
    .description('Switch the global default LLM provider+model (composite)')
    .requiredOption('--provider <name>', 'Provider name (or id, or short prefix)')
    .requiredOption('--model <model>', 'Model id (e.g. gpt-4o)')
    .action(async (opts: { provider: string; model: string }) => {
      const ctx = createContext(parent)
      const provider = await resolveRef(ctx.client, 'provider', opts.provider)
      const before = await ctx.client.get<{ default_llm_provider_id?: string; default_llm_model_id?: string }>(
        '/api/model-config/global'
      )

      const result = await runWrite({
        subcommand: 'config switch-default',
        args: { '--provider': opts.provider, '--model': opts.model },
        command_text: `config switch-default --provider ${opts.provider} --model ${opts.model}`,
        execute: () => ctx.client.patch('/api/model-config/global', {
          default_llm_provider_id: provider.id,
          default_llm_model_id: opts.model,
        }),
        reverseFromResult: () => {
          const oldP = before.default_llm_provider_id
          const oldM = before.default_llm_model_id
          if (oldP && oldM) {
            return {
              command: `config switch-default --provider ${oldP} --model ${oldM}`,
              preview_description: 'restore previous global default LLM',
            }
          }
          return { command: 'config restore-snapshot', preview_description: 'restore previous global config' }
        },
        snapshot: before,
        dataDir: ctx.dataDir,
        actor: process.env['CRABOT_ACTOR'] ?? 'human',
      })
      renderResult(result, { mode: ctx.mode })
    })
}
