import { Command } from 'commander'
import { createContext } from '../../main.js'
import { renderResult } from '../../output.js'
import { resolveRef } from '../../resolve.js'
import type { AdminClient } from '../../client.js'

interface SlotInfo {
  readonly slot: string
  readonly provider_id?: string
  readonly model_id?: string
  readonly provider_test?: { readonly ok: boolean; readonly error?: string }
}

interface DoctorReport {
  readonly agent_id: string
  readonly agent_name: string
  readonly slots: ReadonlyArray<SlotInfo>
}

async function checkAgent(
  client: AdminClient,
  agentId: string,
  agentName: string,
): Promise<DoctorReport> {
  const config = await client.get<{ models?: Record<string, { provider_id?: string; model_id?: string } | null> }>(
    `/api/agent-instances/${agentId}/config`,
  )
  const models = config.models ?? {}

  // De-duplicate provider tests: each provider is tested at most once
  const providerTested = new Map<string, { ok: boolean; error?: string }>()

  const slots: SlotInfo[] = []

  for (const [slotName, slotData] of Object.entries(models)) {
    const providerId = slotData?.provider_id
    const modelId = slotData?.model_id
    let providerTest: { ok: boolean; error?: string } | undefined

    if (providerId) {
      if (!providerTested.has(providerId)) {
        try {
          await client.post<unknown>(`/api/model-providers/${providerId}/test`)
          providerTested.set(providerId, { ok: true })
        } catch (e) {
          providerTested.set(providerId, {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }
      providerTest = providerTested.get(providerId)
    }

    slots.push({
      slot: slotName,
      ...(providerId !== undefined ? { provider_id: providerId } : {}),
      ...(modelId !== undefined ? { model_id: modelId } : {}),
      ...(providerTest !== undefined ? { provider_test: providerTest } : {}),
    })
  }

  return { agent_id: agentId, agent_name: agentName, slots }
}

export function registerAgentDoctorCommand(parent: Command): void {
  const agentCmd = parent.commands.find(c => c.name() === 'agent')
  if (!agentCmd) {
    throw new Error('agent command must be registered first')
  }

  agentCmd
    .command('doctor [ref]')
    .description('Diagnose agent model slot configuration and provider connectivity (composite, read-only)')
    .action(async (ref: string | undefined) => {
      const ctx = createContext(parent)

      let agents: Array<{ id: string; name: string }>
      if (ref) {
        const a = await resolveRef(ctx.client, 'agent', ref)
        agents = [a]
      } else {
        agents = await ctx.client.get<Array<{ id: string; name: string }>>('/api/agent-instances')
      }

      const reports: DoctorReport[] = []
      for (const a of agents) {
        reports.push(await checkAgent(ctx.client, a.id, a.name))
      }

      renderResult({ doctor_reports: reports }, { mode: ctx.mode })
    })
}
