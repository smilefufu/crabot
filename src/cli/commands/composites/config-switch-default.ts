import { Command } from 'commander'
import { createContext, requireSubCommand } from '../../main.js'
import { renderResult } from '../../output.js'
import { resolveRef } from '../../resolve.js'
import { runWrite } from '../../run-write.js'

export function registerConfigSwitchDefaultCommand(parent: Command): void {
  const configCmd = requireSubCommand(parent, 'config')

  configCmd
    .command('switch-default')
    .description('Switch the global default LLM provider+model (composite)')
    .requiredOption('--provider <name>', 'Provider name (or id, or short prefix)')
    .requiredOption('--model <model>', 'Model id (e.g. gpt-4o)')
    .action(async (opts: { provider: string; model: string }) => {
      const ctx = createContext(parent)
      // admin GET 返回 { config: GlobalModelConfig }（包了一层）；PATCH 接受 flat。
      const [provider, before] = await Promise.all([
        resolveRef(ctx.client, 'provider', opts.provider),
        ctx.client.getUnwrap<{ default_llm_provider_id?: string; default_llm_model_id?: string }>(
          '/api/model-config/global',
          'config',
        ),
      ])

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
        actor: ctx.actor,
        mode: ctx.mode,
      })
      renderResult(result, { mode: ctx.mode })
    })
}
