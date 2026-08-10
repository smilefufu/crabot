import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AsyncMutex } from '../workers/async-mutex.js'
import type { ManagerKey } from '../workers/harness/ledger-types.js'

export type PersistedPrincipalBinding = {
  manager_key: ManagerKey
  generation: number
  kind: 'friend' | 'admin_chat_jwt'
  friend_id?: string
  assertion_id?: string
  expires_at?: string
}

type BindingFile = { bindings: PersistedPrincipalBinding[] }
const ADMIN_CHAT_KEY = 'admin-web::admin-chat' as ManagerKey

/** Durable identity bindings only. It never stores permissions, JWTs, or assertion text. */
export class PrincipalBindingStore {
  private readonly mutex = new AsyncMutex()
  private readonly bindings = new Map<ManagerKey, PersistedPrincipalBinding>()
  private initialized = false

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await this.mutex.run(async () => {
      if (this.initialized) return
      try {
        const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as BindingFile
        if (!parsed || !Array.isArray(parsed.bindings)) throw new Error('invalid principal bindings')
        for (const binding of parsed.bindings) {
          this.assertBinding(binding)
          if (this.bindings.has(binding.manager_key)) throw new Error('duplicate manager_key in principal bindings')
          this.bindings.set(binding.manager_key, binding)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      this.initialized = true
    })
  }

  isInitialized(): boolean { return this.initialized }
  get(key: ManagerKey): PersistedPrincipalBinding | undefined { return this.bindings.get(key) }

  async set(binding: Omit<PersistedPrincipalBinding, 'generation'>): Promise<PersistedPrincipalBinding> {
    return this.mutex.run(async () => {
      this.requireInitialized()
      this.assertBinding({ ...binding, generation: 1 })
      const previous = this.bindings.get(binding.manager_key)
      if (previous && sameBinding(previous, binding)) return previous
      const next: PersistedPrincipalBinding = { ...binding, generation: (previous?.generation ?? 0) + 1 }
      this.bindings.set(next.manager_key, next)
      await this.write()
      return next
    })
  }

  /** Bumps one key once; callers can use the returned generation to avoid repeat invalidation. */
  async bump(key: ManagerKey): Promise<PersistedPrincipalBinding | undefined> {
    return this.mutex.run(async () => {
      this.requireInitialized()
      const previous = this.bindings.get(key)
      if (!previous) return undefined
      const next = { ...previous, generation: previous.generation + 1 }
      this.bindings.set(key, next)
      await this.write()
      return next
    })
  }

  async invalidateWhere(predicate: (binding: PersistedPrincipalBinding) => boolean): Promise<void> {
    await this.mutex.run(async () => {
      this.requireInitialized()
      let changed = false
      for (const [key, binding] of this.bindings) {
        if (!predicate(binding)) continue
        this.bindings.set(key, { ...binding, generation: binding.generation + 1 })
        changed = true
      }
      if (changed) await this.write()
    })
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('principal binding store is not initialized')
  }

  private assertBinding(binding: PersistedPrincipalBinding): void {
    if (!binding || !isManagerKey(binding.manager_key) || !Number.isInteger(binding.generation) || binding.generation < 1 ||
      (binding.kind !== 'friend' && binding.kind !== 'admin_chat_jwt')) throw new Error('invalid principal binding')
    if (binding.kind === 'friend') {
      if (!nonEmpty(binding.friend_id) || binding.assertion_id !== undefined || binding.expires_at !== undefined) throw new Error('invalid friend binding')
      return
    }
    if (binding.manager_key !== ADMIN_CHAT_KEY || !nonEmpty(binding.assertion_id) || !nonEmpty(binding.expires_at) ||
      !Number.isFinite(Date.parse(binding.expires_at)) || binding.friend_id !== undefined) throw new Error('invalid admin chat binding')
  }

  private async write(): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true })
    const contents = JSON.stringify({ bindings: [...this.bindings.values()] }, null, 2)
    const temporary = join(dirname(this.filePath), `.tmp-${randomUUID()}.json`)
    await fs.writeFile(temporary, contents, { mode: 0o600 })
    await fs.rename(temporary, this.filePath)
  }
}

function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function isManagerKey(value: unknown): value is ManagerKey {
  return typeof value === 'string' && /^[^:]+::.+$/.test(value)
}
function sameBinding(previous: PersistedPrincipalBinding | undefined, next: Omit<PersistedPrincipalBinding, 'generation'>): boolean {
  return !!previous && previous.kind === next.kind && previous.friend_id === next.friend_id &&
    previous.assertion_id === next.assertion_id && previous.expires_at === next.expires_at
}
