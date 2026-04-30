import { Command } from 'commander'
import { createContext, requireSubCommand } from '../../main.js'
import { CliError } from '../../errors.js'
import { renderResult } from '../../output.js'
import { resolveRef } from '../../resolve.js'
import { runWrite } from '../../run-write.js'

interface ModelSlotRef {
  readonly provider_id: string
  readonly model_id: string
}

interface AgentInstanceConfig {
  readonly model_config?: Record<string, ModelSlotRef | null>
}

export interface AgentSetModelOpts {
  readonly slot: string
  readonly provider: string
  readonly model: string
}

/**
 * 构造 admin PATCH /api/agent-instances/:id/config 的请求体片段（model_config 部分）。
 * admin updateConfig 整体替换 model_config（不 merge），所以调用前必须把 existingSlots 全部传进来，
 * 否则其他 slot 会被清空。
 */
export function buildAgentSetModelBody(
  opts: AgentSetModelOpts & {
    providerId: string
    existingSlots: Record<string, ModelSlotRef | null | undefined>
  }
): Record<string, unknown> {
  if (!opts.slot?.trim()) throw new CliError('INVALID_ARGUMENT', '--slot 不能为空')
  if (!opts.providerId?.trim()) throw new CliError('INVALID_ARGUMENT', 'provider id 解析失败')
  if (!opts.model?.trim()) throw new CliError('INVALID_ARGUMENT', '--model 不能为空')
  const merged: Record<string, ModelSlotRef> = {}
  for (const [k, v] of Object.entries(opts.existingSlots)) {
    if (v && v.provider_id && v.model_id) merged[k] = v
  }
  merged[opts.slot] = { provider_id: opts.providerId, model_id: opts.model }
  return { model_config: merged }
}

export function registerAgentSetModelCommand(parent: Command): void {
  const agentCmd = requireSubCommand(parent, 'agent')

  agentCmd
    .command('set-model <ref>')
    .description('Set the model for a specific slot in an agent (composite command)')
    .requiredOption('--slot <slot>', 'Model slot (例如 default | smart | fast，由 agent 实现声明)')
    .requiredOption('--provider <name>', 'Provider name (or id, or short prefix)')
    .requiredOption('--model <model>', 'Model id (e.g. gpt-4o)')
    .action(async (ref: string, opts: AgentSetModelOpts) => {
      const ctx = createContext(parent)
      const [agent, provider] = await Promise.all([
        resolveRef(ctx.client, 'agent', ref),
        resolveRef(ctx.client, 'provider', opts.provider),
      ])
      // admin GET 返回 { config: ... }；PATCH 接受 flat。要 unwrap 才能读到 model_config。
      const before = await ctx.client.getUnwrap<AgentInstanceConfig>(
        `/api/agent-instances/${agent.id}/config`,
        'config',
      )
      const oldSlot = before.model_config?.[opts.slot]

      const body = buildAgentSetModelBody({
        ...opts,
        providerId: provider.id,
        existingSlots: before.model_config ?? {},
      })

      const result = await runWrite({
        subcommand: 'agent set-model',
        args: {
          '_positional': ref,
          '--slot': opts.slot,
          '--provider': opts.provider,
          '--model': opts.model,
        },
        command_text: `agent set-model ${ref} --slot ${opts.slot} --provider ${opts.provider} --model ${opts.model}`,
        execute: () => ctx.client.patch(`/api/agent-instances/${agent.id}/config`, body),
        reverseFromResult: () => ({
          command: oldSlot && oldSlot.provider_id && oldSlot.model_id
            ? `agent set-model ${ref} --slot ${opts.slot} --provider ${oldSlot.provider_id} --model ${oldSlot.model_id}`
            : `agent config ${ref} --restore-snapshot`,
          preview_description: `restore agent ${agent.name} slot.${opts.slot}`,
        }),
        snapshot: { model_config: { [opts.slot]: oldSlot ?? null } },
        dataDir: ctx.dataDir,
        actor: ctx.actor,
        mode: ctx.mode,
      })

      renderResult(result, { mode: ctx.mode })
    })
}
