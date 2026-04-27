import { Command } from 'commander'
import { createContext, requireSubCommand } from '../../main.js'
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

type ProviderTestResult = { ok: boolean; error?: string }

// Shared dedup cache: each provider is tested at most once across all agents in a single doctor run.
// Caches the in-flight Promise so concurrent agents requesting the same provider share one HTTP call.
type ProviderTestCache = Map<string, Promise<ProviderTestResult>>

function testProvider(client: AdminClient, providerId: string, cache: ProviderTestCache): Promise<ProviderTestResult> {
  const cached = cache.get(providerId)
  if (cached) return cached
  const pending = client
    .post<unknown>(`/api/model-providers/${providerId}/test`)
    .then<ProviderTestResult>(() => ({ ok: true }))
    .catch<ProviderTestResult>((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
  cache.set(providerId, pending)
  return pending
}

async function checkAgent(
  client: AdminClient,
  agentId: string,
  agentName: string,
  cache: ProviderTestCache,
): Promise<DoctorReport> {
  const config = await client.get<{ models?: Record<string, { provider_id?: string; model_id?: string } | null> }>(
    `/api/agent-instances/${agentId}/config`,
  )
  const models = config.models ?? {}

  const slots = await Promise.all(
    Object.entries(models).map(async ([slotName, slotData]) => {
      const providerId = slotData?.provider_id
      const modelId = slotData?.model_id
      const providerTest = providerId ? await testProvider(client, providerId, cache) : undefined
      return {
        slot: slotName,
        ...(providerId !== undefined ? { provider_id: providerId } : {}),
        ...(modelId !== undefined ? { model_id: modelId } : {}),
        ...(providerTest !== undefined ? { provider_test: providerTest } : {}),
      } as SlotInfo
    }),
  )

  return { agent_id: agentId, agent_name: agentName, slots }
}

export function registerAgentDoctorCommand(parent: Command): void {
  const agentCmd = requireSubCommand(parent, 'agent')

  agentCmd
    .command('doctor [ref]')
    .description('Diagnose agent model slot configuration and provider connectivity (composite, read-only)')
    .action(async (ref: string | undefined) => {
      const ctx = createContext(parent)

      const agents: Array<{ id: string; name: string }> = ref
        ? [await resolveRef(ctx.client, 'agent', ref)]
        : await ctx.client.getList<{ id: string; name: string }>('/api/agent-instances')

      const cache: ProviderTestCache = new Map()
      const reports = await Promise.all(agents.map((a) => checkAgent(ctx.client, a.id, a.name, cache)))

      renderResult({ doctor_reports: reports }, { mode: ctx.mode })
    })
}
