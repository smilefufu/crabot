import { CliError } from './errors.js'

export type Domain = 'provider' | 'agent' | 'mcp' | 'skill' | 'channel' | 'schedule' | 'friend' | 'permission'

export const ENDPOINT: Record<Domain, string> = {
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
  getList<T>(path: string): Promise<T[]>
}

interface RawItem {
  readonly id: string
  readonly name?: string
  readonly display_name?: string
  readonly title?: string
}

function nameOf(item: RawItem): string {
  return item.name ?? item.display_name ?? item.title ?? ''
}

function ambiguous(domain: Domain, ref: string, matches: ReadonlyArray<RawItem>, mode: 'name' | 'prefix'): never {
  throw new CliError(
    'AMBIGUOUS_REFERENCE',
    `Reference '${ref}' matches ${matches.length} items in domain '${domain}' by ${mode}`,
    { domain, ref, candidates: matches.map(i => ({ id: i.id, name: nameOf(i) })) },
  )
}

export async function resolveRef(client: ClientLike, domain: Domain, ref: string): Promise<RefResult> {
  const list = await client.getList<RawItem>(ENDPOINT[domain])

  const exact = list.find(item => item.id === ref)
  if (exact) return { id: exact.id, name: nameOf(exact) }

  const byName = list.filter(item => nameOf(item) === ref)
  if (byName.length === 1) return { id: byName[0]!.id, name: nameOf(byName[0]!) }
  if (byName.length > 1) ambiguous(domain, ref, byName, 'name')

  if (ref.length < 4) {
    throw new CliError(
      'INVALID_ARGUMENT',
      `Reference '${ref}' too short for prefix matching (need >= 4 chars)`,
      { domain, ref },
    )
  }

  const byPrefix = list.filter(item => item.id.startsWith(ref))
  if (byPrefix.length === 1) return { id: byPrefix[0]!.id, name: nameOf(byPrefix[0]!) }
  if (byPrefix.length > 1) ambiguous(domain, ref, byPrefix, 'prefix')

  throw new CliError('NOT_FOUND', `No ${domain} found for reference '${ref}'`, { domain, ref })
}
