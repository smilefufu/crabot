import { Command } from 'commander'
import { createContext, type CliContext } from '../main.js'
import { renderResult, type Column } from '../output.js'
import { CliError } from '../errors.js'
import { UndoLog, type UndoEntry } from '../undo-log.js'
import { resolveRef } from '../resolve.js'

const LIST_COLUMNS: Column[] = [
  { key: 'id', header: 'ID' },
  { key: 'executed_at', header: 'WHEN' },
  { key: 'actor', header: 'WHO' },
  { key: 'description', header: 'DESCRIPTION' },
]

async function executeReverse(ctx: CliContext, entry: UndoEntry): Promise<unknown> {
  const cmd = entry.reverse.command.trim()

  // Snapshot restore variants
  if (cmd === 'config restore-snapshot') {
    return ctx.client.patch('/api/model-config/global', entry.snapshot ?? {})
  }
  if (cmd === 'config proxy restore-snapshot') {
    return ctx.client.patch('/api/proxy-config', entry.snapshot ?? {})
  }

  const restoreMatch = cmd.match(
    /^(agent|channel|friend|permission)\s+(config|update)\s+(\S+)\s+--restore-snapshot$/,
  )
  if (restoreMatch) {
    const domain = restoreMatch[1]!
    const ref = restoreMatch[3]!
    type ResolvableDomain = 'agent' | 'channel' | 'friend' | 'permission'
    const endpointMap: Record<ResolvableDomain, { domain: ResolvableDomain; pathFn: (id: string) => string }> = {
      agent: { domain: 'agent', pathFn: (id) => `/api/agent-instances/${id}/config` },
      channel: { domain: 'channel', pathFn: (id) => `/api/channel-instances/${id}/config` },
      friend: { domain: 'friend', pathFn: (id) => `/api/friends/${id}` },
      permission: { domain: 'permission', pathFn: (id) => `/api/permission-templates/${id}` },
    }
    const m = endpointMap[domain as ResolvableDomain]!
    const { id } = await resolveRef(ctx.client, m.domain, ref)
    return ctx.client.patch(m.pathFn(id), entry.snapshot ?? {})
  }

  // mcp undo-import
  if (cmd.startsWith('mcp undo-import ')) {
    const ids = cmd.substring('mcp undo-import '.length).split(',').filter(Boolean)
    const results: unknown[] = []
    for (const id of ids) {
      results.push(await ctx.client.delete(`/api/mcp-servers/${id.trim()}`))
    }
    return { deleted: ids.length, results }
  }

  // Direct commands: parse domain + action + args, dispatch to admin REST
  const tokens = cmd.split(/\s+/)
  const [domain, action, ...rest] = tokens
  if (!domain || !action) {
    throw new CliError('UNDO_STALE', `Cannot parse reverse command: ${cmd}`, { command: cmd })
  }

  // delete <id> patterns
  if (action === 'delete' && rest[0]) {
    const id = rest[0]
    const deleteEndpoint: Record<string, string> = {
      provider: `/api/model-providers/${id}`,
      mcp: `/api/mcp-servers/${id}`,
      skill: `/api/skills/${id}`,
      schedule: `/api/schedules/${id}`,
      friend: `/api/friends/${id}`,
      permission: `/api/permission-templates/${id}`,
    }
    const ep = deleteEndpoint[domain]
    if (!ep) {
      throw new CliError('UNDO_STALE', `Unknown delete domain: ${domain}`, { command: cmd })
    }
    return ctx.client.delete(ep)
  }

  // mcp toggle
  if (domain === 'mcp' && action === 'toggle') {
    const ref = rest[0]!
    const enabled = rest.includes('--on')
    const { id } = await resolveRef(ctx.client, 'mcp', ref)
    return ctx.client.patch(`/api/mcp-servers/${id}`, { enabled })
  }

  // schedule pause / resume
  if (domain === 'schedule' && (action === 'pause' || action === 'resume')) {
    const ref = rest[0]!
    const enabled = action === 'resume'
    const { id } = await resolveRef(ctx.client, 'schedule', ref)
    return ctx.client.patch(`/api/schedules/${id}`, { enabled })
  }

  // agent set-model
  if (domain === 'agent' && action === 'set-model') {
    const ref = rest[0]!
    const slotIdx = rest.indexOf('--slot')
    const provIdx = rest.indexOf('--provider')
    const modelIdx = rest.indexOf('--model')
    if (slotIdx < 0 || provIdx < 0 || modelIdx < 0) {
      throw new CliError('UNDO_STALE', `Malformed set-model reverse: ${cmd}`, { command: cmd })
    }
    const { id: agentId } = await resolveRef(ctx.client, 'agent', ref)
    const slot = rest[slotIdx + 1]!
    const providerRef = rest[provIdx + 1]!
    const model = rest[modelIdx + 1]!
    const { id: providerId } = await resolveRef(ctx.client, 'provider', providerRef)
    return ctx.client.patch(`/api/agent-instances/${agentId}/config`, {
      models: { [slot]: { provider_id: providerId, model_id: model } },
    })
  }

  // config switch-default
  if (domain === 'config' && action === 'switch-default') {
    const provIdx = rest.indexOf('--provider')
    const modelIdx = rest.indexOf('--model')
    const providerRef = rest[provIdx + 1]!
    const model = rest[modelIdx + 1]!
    const { id: providerId } = await resolveRef(ctx.client, 'provider', providerRef)
    return ctx.client.patch('/api/model-config/global', {
      default_llm_provider_id: providerId,
      default_llm_model_id: model,
    })
  }

  throw new CliError('UNDO_STALE', `Unsupported reverse command: ${cmd}`, { command: cmd })
}

async function performUndo(ctx: CliContext, entry: UndoEntry): Promise<unknown> {
  const log = new UndoLog(ctx.dataDir)
  let result: unknown
  try {
    result = await executeReverse(ctx, entry)
  } catch (e) {
    // Stale undo: target likely changed/deleted by another action. Remove the entry
    // to prevent the same failure from recurring on subsequent `crabot undo` calls.
    await log.removeById(entry.id).catch(() => {})
    if (e instanceof CliError) {
      throw new CliError('UNDO_STALE', `Cannot undo: reverse command failed (${e.code}). Entry removed from log.`, {
        undo_id: entry.id,
        reverse_command: entry.reverse.command,
        original_error: e.message,
      })
    }
    throw e
  }
  await log.removeById(entry.id)
  return {
    ok: true,
    undid: entry.id,
    original_command: entry.original_command,
    reverse_command: entry.reverse.command,
    result,
  }
}

export function registerUndoCommands(parent: Command): void {
  const undo = parent
    .command('undo [undo-id]')
    .description('Undo a previous write operation (most recent if no id given)')
    .action(async (undoId: string | undefined) => {
      const ctx = createContext(parent)
      const log = new UndoLog(ctx.dataDir)
      const items = await log.list()
      let target: UndoEntry | undefined
      if (undoId) {
        target = items.find(e => e.id === undoId)
        if (!target) {
          throw new CliError('UNDO_STALE', `No undo entry found with id ${undoId}`, {
            undo_id: undoId,
          })
        }
      } else {
        target = items[0]
        if (!target) {
          throw new CliError('UNDO_EMPTY', 'No undoable operations')
        }
      }
      const result = await performUndo(ctx, target)
      renderResult(result, { mode: ctx.mode })
    })

  undo
    .command('list')
    .description('List undoable operations (newest first)')
    .action(async () => {
      const ctx = createContext(parent)
      const log = new UndoLog(ctx.dataDir)
      const items = await log.list()
      const flatItems = items.map(e => ({
        id: e.id,
        executed_at: e.executed_at,
        actor: e.actor,
        description: e.reverse.preview_description,
        expires_at: e.expires_at,
      }))
      renderResult({ undoable: flatItems }, { mode: ctx.mode, columns: LIST_COLUMNS })
    })
}
