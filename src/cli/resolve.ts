import { CliError } from './errors.js'

export type Domain = 'provider' | 'agent' | 'mcp' | 'skill' | 'channel' | 'schedule' | 'friend' | 'permission'

const ENDPOINT: Record<Domain, string> = {
  provider: '/api/model-providers',
  agent: '/api/agent-instances',
  mcp: '/api/mcp-servers',
  skill: '/api/skills',
  channel: '/api/channel-instances',
  schedule: '/api/schedules',
  friend: '/api/friends',
  permission: '/api/permission-templates',
}

export interface RefResult {
  readonly id: string
  readonly name: string
}

interface ClientLike {
  get<T>(path: string): Promise<T>
}

export async function resolveRef(client: ClientLike, domain: Domain, ref: string): Promise<RefResult> {
  const list = await client.get<Array<{ id: string; name: string }>>(ENDPOINT[domain])

  // 1. 完整 UUID
  const exact = list.find(item => item.id === ref)
  if (exact) return { id: exact.id, name: exact.name }

  // 2. name 精确匹配
  const byName = list.filter(item => item.name === ref)
  if (byName.length === 1) return { id: byName[0]!.id, name: byName[0]!.name }
  if (byName.length > 1) {
    throw new CliError(
      'AMBIGUOUS_REFERENCE',
      `Reference '${ref}' matches ${byName.length} items in domain '${domain}' by name`,
      { domain, ref, candidates: byName.map(i => ({ id: i.id, name: i.name })) },
    )
  }

  // 3. 短前缀
  if (ref.length < 4) {
    throw new CliError(
      'INVALID_ARGUMENT',
      `Reference '${ref}' too short for prefix matching (need >= 4 chars)`,
      { domain, ref },
    )
  }

  const byPrefix = list.filter(item => item.id.startsWith(ref))
  if (byPrefix.length === 1) return { id: byPrefix[0]!.id, name: byPrefix[0]!.name }
  if (byPrefix.length > 1) {
    throw new CliError(
      'AMBIGUOUS_REFERENCE',
      `Reference '${ref}' matches ${byPrefix.length} items in domain '${domain}' by prefix`,
      { domain, ref, candidates: byPrefix.map(i => ({ id: i.id, name: i.name })) },
    )
  }

  throw new CliError('NOT_FOUND', `No ${domain} found for reference '${ref}'`, { domain, ref })
}
