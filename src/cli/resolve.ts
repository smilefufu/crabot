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

interface RawItem {
  readonly id: string
  readonly name?: string
  readonly display_name?: string
  readonly title?: string
}

function nameOf(item: RawItem): string {
  return item.name ?? item.display_name ?? item.title ?? ''
}

function unwrap(raw: unknown): ReadonlyArray<RawItem> {
  if (Array.isArray(raw)) return raw as ReadonlyArray<RawItem>
  if (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)) {
    return (raw as { items: RawItem[] }).items
  }
  return []
}

export async function resolveRef(client: ClientLike, domain: Domain, ref: string): Promise<RefResult> {
  const raw = await client.get<unknown>(ENDPOINT[domain])
  const list = unwrap(raw)

  // 1. 完整 ID 命中
  const exact = list.find(item => item.id === ref)
  if (exact) return { id: exact.id, name: nameOf(exact) }

  // 2. name 精确匹配
  const byName = list.filter(item => nameOf(item) === ref)
  if (byName.length === 1) return { id: byName[0]!.id, name: nameOf(byName[0]!) }
  if (byName.length > 1) {
    throw new CliError(
      'AMBIGUOUS_REFERENCE',
      `Reference '${ref}' matches ${byName.length} items in domain '${domain}' by name`,
      { domain, ref, candidates: byName.map(i => ({ id: i.id, name: nameOf(i) })) },
    )
  }

  // 3. 短前缀（仅当 ref 看起来像 UUID 前缀时；name 为完整 ID 时也走前面的精确分支）
  if (ref.length < 4) {
    throw new CliError(
      'INVALID_ARGUMENT',
      `Reference '${ref}' too short for prefix matching (need >= 4 chars)`,
      { domain, ref },
    )
  }

  const byPrefix = list.filter(item => item.id.startsWith(ref))
  if (byPrefix.length === 1) return { id: byPrefix[0]!.id, name: nameOf(byPrefix[0]!) }
  if (byPrefix.length > 1) {
    throw new CliError(
      'AMBIGUOUS_REFERENCE',
      `Reference '${ref}' matches ${byPrefix.length} items in domain '${domain}' by prefix`,
      { domain, ref, candidates: byPrefix.map(i => ({ id: i.id, name: nameOf(i) })) },
    )
  }

  throw new CliError('NOT_FOUND', `No ${domain} found for reference '${ref}'`, { domain, ref })
}
