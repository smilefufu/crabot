import { Command } from 'commander'
import { createContext, requireSubCommand } from '../../main.js'
import { renderResult } from '../../output.js'
import { resolveRef } from '../../resolve.js'
import { runWrite } from '../../run-write.js'

interface AgentConfig {
  readonly models?: Record<string, { provider_id?: string; model_id?: string } | null>
}

export function registerAgentSetModelCommand(parent: Command): void {
  const agentCmd = requireSubCommand(parent, 'agent')

  agentCmd
    .command('set-model <ref>')
    .description('Set the model for a specific slot in an agent (composite command)')
    .requiredOption('--slot <slot>', 'Model slot: default | smart | fast')
    .requiredOption('--provider <name>', 'Provider name (or id, or short prefix)')
    .requiredOption('--model <model>', 'Model id (e.g. gpt-4o)')
    .action(async (ref: string, opts: { slot: string; provider: string; model: string }) => {
      const ctx = createContext(parent)
      const agent = await resolveRef(ctx.client, 'agent', ref)
      const provider = await resolveRef(ctx.client, 'provider', opts.provider)
      const before = await ctx.client.get<AgentConfig>(`/api/agent-instances/${agent.id}/config`)
      const oldSlot = before.models?.[opts.slot]

      const result = await runWrite({
        subcommand: 'agent set-model',
        args: {
          '_positional': ref,
          '--slot': opts.slot,
          '--provider': opts.provider,
          '--model': opts.model,
        },
        command_text: `agent set-model ${ref} --slot ${opts.slot} --provider ${opts.provider} --model ${opts.model}`,
        execute: () => ctx.client.patch(`/api/agent-instances/${agent.id}/config`, {
          models: { [opts.slot]: { provider_id: provider.id, model_id: opts.model } },
        }),
        reverseFromResult: () => ({
          command: oldSlot && oldSlot.provider_id && oldSlot.model_id
            ? `agent set-model ${ref} --slot ${opts.slot} --provider ${oldSlot.provider_id} --model ${oldSlot.model_id}`
            : `agent config ${ref} --restore-snapshot`,
          preview_description: `restore agent ${agent.name} slot.${opts.slot}`,
        }),
        snapshot: { models: { [opts.slot]: oldSlot ?? null } },
        dataDir: ctx.dataDir,
        actor: ctx.actor,
        mode: ctx.mode,
      })

      renderResult(result, { mode: ctx.mode })
    })
}
