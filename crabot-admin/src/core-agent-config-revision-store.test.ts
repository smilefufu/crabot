import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CoreAgentConfigMutationCoordinator, type ConfigMutationHooks } from './core-agent-config-revision-store.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(hooks: ConfigMutationHooks = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-config-coordinator-'))
  let state = { provider: 'before', secret: 'initial-secret' }
  const events: Array<{ config_revision: number; domains: string[] }> = []
  const coordinator = new CoreAgentConfigMutationCoordinator(dir, {
    readSemanticSnapshot: () => ({ provider: state.provider, secret: state.secret }),
    publishInvalidation: (payload) => { events.push({ config_revision: payload.config_revision, domains: [...payload.domains] }) },
    hooks,
  })
  await coordinator.initialize()
  return { dir, state, events, coordinator }
}

async function cleanup(dir: string) { await fs.rm(dir, { recursive: true, force: true }) }
const outbox = (dir: string) => path.join(dir, 'config', 'core-agent-config-mutation-outbox.json')
const record = (dir: string) => path.join(dir, 'config', 'core-agent-config-revision.json')
const key = (dir: string) => path.join(dir, 'config', 'core-agent-config-hmac-key')

describe('CoreAgentConfigMutationCoordinator', () => {
  it('serializes mutations, HMACs secret-inclusive snapshots, and publishes exact nonsecret payloads', async () => {
    const f = await fixture()
    try {
      await Promise.all([
        f.coordinator.mutate(['models'], { provider: 'one', secret: 'initial-secret' }, async () => { f.state.provider = 'one' }),
        f.coordinator.mutate(['skills'], { provider: 'two', secret: 'rotated' }, async () => { f.state.provider = 'two'; f.state.secret = 'rotated' }),
      ])
      expect((await f.coordinator.current()).revision).toBe(3)
      expect(f.events).toEqual([
        { config_revision: 2, domains: ['models'] },
        { config_revision: 3, domains: ['skills'] },
      ])
      const persisted = await fs.readFile(record(f.dir), 'utf8')
      expect(persisted).not.toContain('rotated')
      expect(await fs.stat(key(f.dir))).toMatchObject({ mode: expect.any(Number) })
      expect((await fs.stat(key(f.dir))).mode & 0o777).toBe(0o600)
      await expect(fs.access(outbox(f.dir))).rejects.toThrow()
    } finally { await cleanup(f.dir) }
  })

  it('rejects an epoch when a mutation creates an outbox between its two persisted-state reads', async () => {
    const firstRead = deferred()
    const releaseRead = deferred()
    const prepared = deferred()
    const releaseMutation = deferred()
    let pauseEpoch = true
    const f = await fixture({
      afterEpochOutboxRead: async () => {
        if (!pauseEpoch) return
        pauseEpoch = false
        firstRead.resolve()
        await releaseRead.promise
      },
      afterPrepared: async () => {
        prepared.resolve()
        await releaseMutation.promise
      },
    })
    try {
      const epochRead = f.coordinator.readCommittedEpoch()
      await firstRead.promise
      const mutation = f.coordinator.mutate(
        ['models'],
        { provider: 'after', secret: 'initial-secret' },
        async () => { f.state.provider = 'after' },
      )
      await prepared.promise
      releaseRead.resolve()
      await expect(epochRead).resolves.toBeNull()
      releaseMutation.resolve()
      await mutation
      await expect(f.coordinator.readCommittedEpoch()).resolves.toEqual({ revision: 2, generation: 2 })
    } finally { await cleanup(f.dir) }
  })

  it('changes the generation token even when an attempted mutation ends without a revision commit', async () => {
    const f = await fixture()
    try {
      const before = await f.coordinator.readCommittedEpoch()
      await expect(f.coordinator.mutate(
        ['models'],
        { provider: 'before', secret: 'initial-secret' },
        async () => { throw new Error('must not run') },
      )).rejects.toThrow('did not change semantic snapshot')
      const after = await f.coordinator.readCommittedEpoch()
      expect(before).toEqual({ revision: 1, generation: 0 })
      expect(after).toEqual({ revision: 1, generation: 2 })
      expect(after).not.toEqual(before)
    } finally { await cleanup(f.dir) }
  })

  it('fails closed when a committed no-outbox source fingerprint no longer matches', async () => {
    const f = await fixture()
    try {
      f.state.provider = 'tampered-after-commit'
      const restarted = new CoreAgentConfigMutationCoordinator(f.dir, {
        readSemanticSnapshot: () => ({ provider: f.state.provider, secret: f.state.secret }),
        publishInvalidation: () => {},
      })
      await expect(restarted.initialize()).rejects.toThrow('semantic fingerprint does not match committed revision')
    } finally { await cleanup(f.dir) }
  })

  it('clears prepared state when source callback never ran and never invokes it during recovery', async () => {
    let calls = 0
    const f = await fixture({ afterPrepared: () => { throw new Error('simulated crash') } })
    try {
      await expect(f.coordinator.mutate(['models'], { provider: 'after', secret: 'initial-secret' }, async () => { calls++; f.state.provider = 'after' })).rejects.toThrow('simulated crash')
      expect(calls).toBe(0)
      const restarted = new CoreAgentConfigMutationCoordinator(f.dir, {
        readSemanticSnapshot: () => ({ provider: f.state.provider, secret: f.state.secret }),
        publishInvalidation: (payload) => f.events.push(payload),
      })
      await restarted.initialize()
      expect((await restarted.current()).revision).toBe(1)
      await expect(fs.access(outbox(f.dir))).rejects.toThrow()
      expect(calls).toBe(0)
    } finally { await cleanup(f.dir) }
  })

  it('finishes prepared recovery when the declared after snapshot is already persisted', async () => {
    let f!: Awaited<ReturnType<typeof fixture>>
    f = await fixture({ afterPrepared: () => { f.state.provider = 'after'; throw new Error('simulated crash') } })
    try {
      await expect(f.coordinator.mutate(['models'], { provider: 'after', secret: 'initial-secret' }, async () => { throw new Error('must not execute') })).rejects.toThrow('simulated crash')
      const restarted = new CoreAgentConfigMutationCoordinator(f.dir, {
        readSemanticSnapshot: () => ({ provider: f.state.provider, secret: f.state.secret }),
        publishInvalidation: (payload) => f.events.push(payload),
      })
      await restarted.initialize()
      expect((await restarted.current()).revision).toBe(2)
      await restarted.drainPendingInvalidation()
      expect(f.events).toEqual([{ config_revision: 2, domains: ['models'] }])
    } finally { await cleanup(f.dir) }
  })

  it('recovers data_persisted state using after semantic fingerprint', async () => {
    const f = await fixture({ afterSourceMutation: () => { throw new Error('simulated crash') } })
    try {
      await expect(f.coordinator.mutate(['models'], { provider: 'after', secret: 'initial-secret' }, async () => { f.state.provider = 'after' })).rejects.toThrow('simulated crash')
      const restarted = new CoreAgentConfigMutationCoordinator(f.dir, {
        readSemanticSnapshot: () => ({ provider: f.state.provider, secret: f.state.secret }),
        publishInvalidation: (payload) => f.events.push(payload),
      })
      await restarted.initialize()
      expect((await restarted.current()).revision).toBe(2)
      await restarted.drainPendingInvalidation()
      expect(f.events).toEqual([{ config_revision: 2, domains: ['models'] }])
    } finally { await cleanup(f.dir) }
  })

  it('retains the durable outbox when invalidation publication fails and retries it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-config-coordinator-publish-fail-'))
    let state = 'before'
    let fail = true
    const events: Array<{ config_revision: number; domains: string[] }> = []
    const coordinator = new CoreAgentConfigMutationCoordinator(dir, {
      readSemanticSnapshot: () => ({ state }),
      publishInvalidation: async (payload) => {
        if (fail) throw new Error('publish unavailable')
        events.push({ config_revision: payload.config_revision, domains: [...payload.domains] })
      },
    })
    try {
      await coordinator.initialize()
      await expect(coordinator.mutate(['models'], { state: 'after' }, async () => { state = 'after' }))
        .rejects.toThrow('publish unavailable')
      expect(JSON.parse(await fs.readFile(outbox(dir), 'utf8'))).toMatchObject({
        state: 'committed', invalidation_pending: true, target_revision: 2,
      })
      fail = false
      await coordinator.drainPendingInvalidation()
      expect(events).toEqual([{ config_revision: 2, domains: ['models'] }])
      await expect(fs.access(outbox(dir))).rejects.toThrow()
    } finally { await cleanup(dir) }
  })

  it('keeps coherent reads open while a committed outbox only awaits hint publication', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-config-coordinator-epoch-'))
    let state = 'before'
    let fail = true
    const coordinator = new CoreAgentConfigMutationCoordinator(dir, {
      readSemanticSnapshot: () => ({ state }),
      publishInvalidation: async () => { if (fail) throw new Error('publish unavailable') },
      onInvalidationPublishFailure: () => {},
    })
    try {
      await coordinator.initialize()
      await expect(coordinator.mutate(['models'], { state: 'after' }, async () => { state = 'after' })).rejects.toThrow('publish unavailable')
      // outbox 卡在 committed/invalidation_pending：source 与 record 一致，一致性读必须可用，
      // 不能把 get_agent_config 永久锁死。
      const epoch = await coordinator.readCommittedEpoch()
      expect(epoch).toMatchObject({ revision: 2 })
      // 后台 drain 重试清掉 outbox 后，mutation 也恢复可用。
      fail = false
      await coordinator.drainPendingInvalidation()
      await coordinator.mutate(['behavior'], { state: 'later' }, async () => { state = 'later' })
      expect((await coordinator.current()).revision).toBe(3)
    } finally { await cleanup(dir) }
  })

  it('does not overwrite a publish-loss outbox with a later mutation', async () => {
    const f = await fixture({ afterPublish: () => { throw new Error('response lost') } })
    try {
      await expect(f.coordinator.mutate(['models'], { provider: 'after', secret: 'initial-secret' }, async () => { f.state.provider = 'after' })).rejects.toThrow('response lost')
      const original = await fs.readFile(outbox(f.dir), 'utf8')
      await expect(f.coordinator.mutate(['skills'], { provider: 'later', secret: 'initial-secret' }, async () => { f.state.provider = 'later' })).rejects.toThrow('already active')
      expect(await fs.readFile(outbox(f.dir), 'utf8')).toBe(original)
      expect(f.state.provider).toBe('after')
    } finally { await cleanup(f.dir) }
  })

  it('recovers committed revision and exact pending invalidation after publish response loss', async () => {
    const f = await fixture({ afterPublish: () => { throw new Error('response lost') } })
    try {
      await expect(f.coordinator.mutate(['mcp'], { provider: 'after', secret: 'initial-secret' }, async () => { f.state.provider = 'after' })).rejects.toThrow('response lost')
      expect((await f.coordinator.current()).revision).toBe(2)
      expect(await fs.readFile(outbox(f.dir), 'utf8')).not.toContain('initial-secret')
      const restarted = new CoreAgentConfigMutationCoordinator(f.dir, {
        readSemanticSnapshot: () => ({ provider: f.state.provider, secret: f.state.secret }),
        publishInvalidation: (payload) => f.events.push(payload),
      })
      await restarted.initialize()
      await restarted.drainPendingInvalidation()
      expect(f.events).toEqual([
        { config_revision: 2, domains: ['mcp'] },
        { config_revision: 2, domains: ['mcp'] },
      ])
      await expect(fs.access(outbox(f.dir))).rejects.toThrow()
    } finally { await cleanup(f.dir) }
  })

  it('rejects persisted domains outside the closed protocol set', async () => {
    const f = await fixture({ afterPrepared: () => { throw new Error('stop') } })
    try {
      await expect(f.coordinator.mutate(['models'], { provider: 'after', secret: 'initial-secret' }, async () => { f.state.provider = 'after' })).rejects.toThrow('stop')
      const persisted = JSON.parse(await fs.readFile(outbox(f.dir), 'utf8'))
      persisted.domains = ['models', 'not-a-domain']
      await fs.writeFile(outbox(f.dir), JSON.stringify(persisted))
      const restarted = new CoreAgentConfigMutationCoordinator(f.dir, {
        readSemanticSnapshot: () => f.state,
        publishInvalidation: () => {},
      })
      await expect(restarted.initialize()).rejects.toThrow('Invalid config mutation domains')
    } finally { await cleanup(f.dir) }
  })

  it('fails closed for ambiguous, corrupt, missing-key, and regressed persisted state', async () => {
    const f = await fixture({ afterPrepared: () => { throw new Error('stop') } })
    try {
      await expect(f.coordinator.mutate(['models'], { provider: 'after', secret: 'initial-secret' }, async () => { f.state.provider = 'after' })).rejects.toThrow('stop')
      await fs.writeFile(outbox(f.dir), '{not-json}', { mode: 0o600 })
      await expect(new CoreAgentConfigMutationCoordinator(f.dir, { readSemanticSnapshot: () => f.state, publishInvalidation: () => {} }).initialize()).rejects.toThrow('Invalid persisted')
      await fs.rm(outbox(f.dir), { force: true })
      await fs.writeFile(record(f.dir), JSON.stringify({ schema_version: 1, revision: 0, semantic_fingerprint_hmac: 'a'.repeat(64), updated_at: '' }), { mode: 0o600 })
      await expect(new CoreAgentConfigMutationCoordinator(f.dir, { readSemanticSnapshot: () => f.state, publishInvalidation: () => {} }).initialize()).rejects.toThrow('Invalid core Agent config revision')
      await fs.rm(key(f.dir))
      await expect(new CoreAgentConfigMutationCoordinator(f.dir, { readSemanticSnapshot: () => f.state, publishInvalidation: () => {} }).initialize()).rejects.toThrow('Missing core Agent config HMAC key')
    } finally { await cleanup(f.dir) }
  })

  it('aborts the prepared outbox when a failed source mutation rolls back to before', async () => {
    const f = await fixture()
    try {
      await expect(f.coordinator.mutate(['models'], { provider: 'unchanged', secret: 'initial-secret' }, async () => { throw new Error('disk write failed') }))
        .rejects.toThrow('disk write failed')
      // 源状态未变：outbox 必须被原子中止，运行期不得锁死（无 journal binding 不写 receipt）。
      await expect(fs.access(outbox(f.dir))).rejects.toThrow()
      expect((await f.coordinator.current()).revision).toBe(1)
      // 后续 mutation 与一致性读立即可用。
      expect(await f.coordinator.readCommittedEpoch()).toMatchObject({ revision: 1 })
      await f.coordinator.mutate(['behavior'], { provider: 'next', secret: 'initial-secret' }, async () => { f.state.provider = 'next' })
      expect((await f.coordinator.current()).revision).toBe(2)
    } finally { await cleanup(f.dir) }
  })

  it('unlocks config writes when runtime abort cleanup clears a bound source journal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-config-coordinator-journal-'))
    const state = { provider: 'before' }
    let bound: { mutation_id: string; target_revision: number; digest: string } | undefined
    const aborts: number[] = []
    const coordinator = new CoreAgentConfigMutationCoordinator(dir, {
      readSemanticSnapshot: () => ({ ...state }),
      publishInvalidation: () => {},
      abortSourceJournal: async () => {
        aborts.push(1)
        // 源端运行期清理：与启动期 recover 同形（mark cleanup → clear binding）。
        await coordinator.markSourceJournalCleanupCompleted(bound!.mutation_id, bound!.target_revision, bound!.digest)
        await coordinator.clearCompletedSourceJournalBinding(bound!.mutation_id, bound!.target_revision, bound!.digest)
      },
    })
    try {
      await coordinator.initialize()
      await expect(coordinator.mutate(['skills'], { provider: 'after' }, async (ctx) => {
        await ctx.bindSourceJournal('a'.repeat(64))
        bound = { mutation_id: ctx.mutation_id, target_revision: ctx.target_revision, digest: 'a'.repeat(64) }
        throw new Error('applyFiles failed')
      })).rejects.toThrow('applyFiles failed')
      expect(aborts).toEqual([1])
      // 清理成功后配置读写立即解锁，不得等重启。
      await coordinator.mutate(['behavior'], { provider: 'next' }, async () => { state.provider = 'next' })
      expect((await coordinator.current()).revision).toBe(2)
    } finally { await cleanup(dir) }
  })

  it('keeps the journal binding locked for restart recovery when runtime abort cleanup fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-config-coordinator-journal-fail-'))
    const state = { provider: 'before' }
    const coordinator = new CoreAgentConfigMutationCoordinator(dir, {
      readSemanticSnapshot: () => ({ ...state }),
      publishInvalidation: () => {},
      abortSourceJournal: async () => { throw new Error('cleanup unavailable') },
    })
    try {
      await coordinator.initialize()
      await expect(coordinator.mutate(['skills'], { provider: 'after' }, async (ctx) => {
        await ctx.bindSourceJournal('b'.repeat(64))
        throw new Error('applyFiles failed')
      })).rejects.toThrow('applyFiles failed')
      // 运行期清理失败：binding 保留在 receipt 上，配置写入继续被挡（启动期 verify/recover 兜底）。
      await expect(coordinator.mutate(['behavior'], { provider: 'x' }, async () => {}))
        .rejects.toThrow('Core Agent source journal cleanup is still active')
    } finally { await cleanup(dir) }
  })

  it('retains the prepared outbox when a failed source mutation leaves diverged state', async () => {
    const f = await fixture()
    try {
      await expect(f.coordinator.mutate(['models'], { provider: 'after', secret: 'initial-secret' }, async () => {
        f.state.provider = 'after'
        throw new Error('disk write failed after memory advanced')
      })).rejects.toThrow('disk write failed after memory advanced')
      // 内存态已推进到 after、与磁盘 before 不一致：保留 durable outbox，由重启恢复 fail-loud。
      const pending = JSON.parse(await fs.readFile(outbox(f.dir), 'utf8'))
      expect(pending.state).toBe('prepared')
      await expect(f.coordinator.mutate(['behavior'], { provider: 'x', secret: 'initial-secret' }, async () => {})).rejects.toThrow('already active')
    } finally { await cleanup(f.dir) }
  })

  it('rejects mismatch recovery instead of resetting revision or applying a callback twice', async () => {
    const f = await fixture({ afterSourceMutation: () => { throw new Error('stop') } })
    try {
      let calls = 0
      await expect(f.coordinator.mutate(['models'], { provider: 'after', secret: 'initial-secret' }, async () => { calls++; f.state.provider = 'after' })).rejects.toThrow('stop')
      f.state.provider = 'third-state'
      const restarted = new CoreAgentConfigMutationCoordinator(f.dir, { readSemanticSnapshot: () => f.state, publishInvalidation: () => {} })
      await expect(restarted.initialize()).rejects.toThrow('Config mutation source state does not match outbox')
      expect(calls).toBe(1)
    } finally { await cleanup(f.dir) }
  })

  it('uses 0600 for record and outbox and preserves monotonic revision across restart', async () => {
    const f = await fixture({ afterRevisionCommit: () => { throw new Error('crash after commit') } })
    try {
      await expect(f.coordinator.mutate(['behavior'], { provider: 'after', secret: 'initial-secret' }, async () => { f.state.provider = 'after' })).rejects.toThrow('crash after commit')
      expect((await fs.stat(record(f.dir))).mode & 0o777).toBe(0o600)
      expect((await fs.stat(outbox(f.dir))).mode & 0o777).toBe(0o600)
      const restarted = new CoreAgentConfigMutationCoordinator(f.dir, {
        readSemanticSnapshot: () => f.state,
        publishInvalidation: (payload) => f.events.push(payload),
      })
      await restarted.initialize()
      await restarted.drainPendingInvalidation()
      expect((await restarted.current()).revision).toBe(2)
      await restarted.mutate(['image'], { provider: 'later', secret: 'initial-secret' }, async () => { f.state.provider = 'later' })
      expect((await restarted.current()).revision).toBe(3)
    } finally { await cleanup(f.dir) }
  })
})
