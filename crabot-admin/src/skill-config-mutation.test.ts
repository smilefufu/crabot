import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { CoreAgentConfigMutationCoordinator } from './core-agent-config-revision-store.js'
import { SkillManager } from './mcp-skill-manager.js'

const skill = (name: string, body = 'body') => `---\nname: ${name}\ndescription: ${name}\nversion: 1.0.0\n---\n${body}`

describe('Skill source mutation journal', () => {
  it('does not materialize target before prepared and removes the source journal only after success', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-journal-'))
    try {
      const manager = new SkillManager(dir)
      await manager.initializeLoadOnly()
      const coordinator = new CoreAgentConfigMutationCoordinator(dir, {
        readSemanticSnapshot: () => ({ skills: manager.runtimeSemanticEntries(), storage: manager.semanticMigrationState() }),
        publishInvalidation: () => {},
        hooks: {
          afterPrepared: async () => {
            await expect(fs.access(path.join(dir, 'skills', 'demo'))).rejects.toThrow()
            await expect(fs.access(path.join(dir, 'skills', '.transactions', 'skill-source-journal.json'))).rejects.toThrow()
          },
          afterSourceMutation: async () => {
            await expect(fs.access(path.join(dir, 'skills', '.transactions', 'skill-source-journal.json'))).resolves.toBeUndefined()
          },
        },
      })
      manager.setSemanticSnapshotProvider(() => ({ skills: manager.runtimeSemanticEntries(), storage: manager.semanticMigrationState() }))
      manager.setMutationRunner((domains, preview, apply) => coordinator.mutateComputed(domains, preview, apply).then(() => undefined))
      await coordinator.initialize()
      await manager.create({ name: 'demo', description: 'demo', content: skill('demo') })
      await expect(fs.readFile(path.join(dir, 'skills', 'demo', 'SKILL.md'), 'utf8')).resolves.toContain('body')
      await expect(fs.access(path.join(dir, 'skills', '.transactions', 'skill-source-journal.json'))).rejects.toThrow()
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('rolls the preview back when content hashing fails, keeping the registry coherent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-preview-rollback-'))
    try {
      const manager = new SkillManager(dir); await manager.initializeLoadOnly()
      const snapshot = () => ({ skills: manager.runtimeSemanticEntries(), storage: manager.semanticMigrationState() })
      const coordinator = new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: snapshot, publishInvalidation: () => {} })
      manager.setSemanticSnapshotProvider(snapshot)
      manager.setMutationRunner((domains, preview, apply, allowRuntimeNoop, options) => coordinator.mutateComputed(domains, preview, apply, allowRuntimeNoop, options).then(() => undefined))
      await coordinator.initialize()
      await manager.create({ name: 'demo', description: 'd', content: skill('demo') })
      const entry = manager.list().find((item) => item.name === 'demo')!
      // 向 skill 目录注入 symlink：refreshRuntimeContentHashes 会 throw。
      await fs.symlink('/nonexistent-target', path.join(entry.skill_dir, 'evil-link'))
      await expect(manager.update(entry.id, { enabled: false })).rejects.toThrow('Symlink in imported skill directory')
      // preview 必须完整回滚：registry 不被停在未落盘的 next，fingerprint 不错位。
      expect(manager.get(entry.id)?.enabled).toBe(true)
      expect((await coordinator.current()).revision).toBe(2)
      // 清掉 symlink 后同一操作立即恢复——没有被永久锁死。
      await fs.rm(path.join(entry.skill_dir, 'evil-link'))
      await manager.update(entry.id, { enabled: false })
      expect(manager.get(entry.id)?.enabled).toBe(false)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('deletes a disabled skill through the journal-aware noop lifecycle without locking writes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-disabled-delete-'))
    try {
      const manager = new SkillManager(dir); await manager.initializeLoadOnly()
      const snapshot = () => ({ skills: manager.runtimeSemanticEntries(), storage: manager.semanticMigrationState() })
      const coordinator = new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: snapshot, publishInvalidation: () => {} })
      manager.setSemanticSnapshotProvider(snapshot)
      manager.setMutationRunner((domains, preview, apply, allowRuntimeNoop, options) => coordinator.mutateComputed(domains, preview, apply, allowRuntimeNoop, options).then(() => undefined))
      await coordinator.initialize()
      await manager.create({ name: 'temp', description: 'd', content: skill('temp') })
      const entry = manager.list().find((item) => item.name === 'temp')!
      await manager.update(entry.id, { enabled: false })
      const revisionBefore = (await coordinator.current()).revision
      // 停用 skill 不在 runtime 投影里，但删除仍有 journal 保护的物理操作：
      // 走 journal-aware noop 的完整生命周期，不得抛 noop 错误、不得留下 journal。
      await manager.delete(entry.id)
      expect(manager.get(entry.id)).toBeUndefined()
      expect((await coordinator.current()).revision).toBeGreaterThan(revisionBefore)
      await expect(fs.access(path.join(dir, 'skills', '.transactions', 'skill-source-journal.json'))).rejects.toThrow()
      // 后续写入不被锁。
      await manager.create({ name: 'next', description: 'd', content: skill('next') })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('rejects tampered after-state content before coordinator recovery trusts the journal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-after-tamper-'))
    try {
      const manager = new SkillManager(dir); await manager.initializeLoadOnly()
      const snapshot = () => ({ skills: manager.runtimeSemanticEntries(), storage: manager.semanticMigrationState() })
      const coordinator = new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: snapshot, publishInvalidation: () => {}, hooks: { afterPublish: () => { throw new Error('response lost') } } })
      manager.setSemanticSnapshotProvider(snapshot)
      manager.setMutationRunner((domains, preview, apply) => coordinator.mutateComputed(domains, preview, apply).then(() => undefined))
      await coordinator.initialize()
      await expect(manager.create({ name: 'after-tamper', description: 'x', content: skill('after-tamper') })).rejects.toThrow('response lost')
      await fs.appendFile(path.join(dir, 'skills', 'after-tamper', 'SKILL.md'), 'tampered')
      const restarted = new SkillManager(dir); await restarted.initializeLoadOnly()
      const recovered = new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: () => ({ skills: restarted.runtimeSemanticEntries(), storage: restarted.semanticMigrationState() }), publishInvalidation: () => {} })
      await expect(restarted.verifySourceJournalBinding(recovered)).rejects.toThrow('tree mismatch')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('projects journal after-state through publish response loss and finalizes it on restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-publish-loss-'))
    try {
      const manager = new SkillManager(dir); await manager.initializeLoadOnly()
      const snapshot = () => ({ skills: manager.runtimeSemanticEntries(), storage: manager.semanticMigrationState() })
      const coordinator = new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: snapshot, publishInvalidation: () => {}, hooks: { afterPublish: () => { throw new Error('response lost') } } })
      manager.setSemanticSnapshotProvider(snapshot)
      manager.setMutationRunner((domains, preview, apply) => coordinator.mutateComputed(domains, preview, apply).then(() => undefined))
      await coordinator.initialize()
      await expect(manager.create({ name: 'lost', description: 'lost', content: skill('lost') })).rejects.toThrow('response lost')
      const journal = path.join(dir, 'skills', '.transactions', 'skill-source-journal.json')
      await expect(fs.access(journal)).resolves.toBeUndefined()
      const restarted = new SkillManager(dir); await restarted.initializeLoadOnly()
      const restartedSnapshot = () => ({ skills: restarted.runtimeSemanticEntries(), storage: restarted.semanticMigrationState() })
      const recovered = new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: restartedSnapshot, publishInvalidation: () => {} })
      await restarted.verifySourceJournalBinding(recovered)
      await recovered.initialize()
      await restarted.recoverSourceJournal(recovered)
      await expect(fs.access(journal)).rejects.toThrow()
      expect((await recovered.current()).revision).toBe(2)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('rejects a plain journal digest rewrite without the coordinator HMAC', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-binding-tamper-'))
    try {
      const manager = new SkillManager(dir); await manager.initializeLoadOnly()
      const snapshot = () => ({ skills: manager.runtimeSemanticEntries(), storage: manager.semanticMigrationState() })
      const coordinator = new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: snapshot, publishInvalidation: () => {}, hooks: { afterPublish: () => { throw new Error('response lost') } } })
      manager.setSemanticSnapshotProvider(snapshot)
      manager.setMutationRunner((domains, preview, apply) => coordinator.mutateComputed(domains, preview, apply).then(() => undefined))
      await coordinator.initialize()
      await expect(manager.create({ name: 'binding', description: 'x', content: skill('binding') })).rejects.toThrow('response lost')
      const outboxPath = path.join(dir, 'config', 'core-agent-config-mutation-outbox.json')
      const persisted = JSON.parse(await fs.readFile(outboxPath, 'utf8'))
      persisted.source_journal_sha256 = 'a'.repeat(64)
      await fs.writeFile(outboxPath, JSON.stringify(persisted))
      const restarted = new SkillManager(dir); await restarted.initializeLoadOnly()
      const recovered = new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: () => ({ skills: restarted.runtimeSemanticEntries(), storage: restarted.semanticMigrationState() }), publishInvalidation: () => {} })
      await expect(restarted.verifySourceJournalBinding(recovered)).rejects.toThrow('binding mismatch')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('fails closed after direct imported content tampering', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-tamper-'))
    try {
      const manager = new SkillManager(dir); await manager.initializeLoadOnly()
      const snapshot = () => ({ skills: manager.runtimeSemanticEntries(), storage: manager.semanticMigrationState() })
      const coordinator = new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: snapshot, publishInvalidation: () => {} })
      manager.setSemanticSnapshotProvider(snapshot)
      manager.setMutationRunner((domains, preview, apply) => coordinator.mutateComputed(domains, preview, apply).then(() => undefined))
      await coordinator.initialize(); const entry = await manager.create({ name: 'tamper', description: 'tamper', content: skill('tamper') })
      await fs.appendFile(path.join(entry.skill_dir, 'SKILL.md'), ' altered')
      const restarted = new SkillManager(dir); await restarted.initializeLoadOnly()
      // fail-open（protocol-admin 0.2.5 §3.19.8.1）：无 outbox 的源漂移不再拒绝启动，
      // 以 live 投影重记账 revision+1；再次重启指纹一致，revision 不再前进。
      const tamperedSnapshot = () => ({ skills: restarted.runtimeSemanticEntries(), storage: restarted.semanticMigrationState() })
      const first = new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: tamperedSnapshot, publishInvalidation: () => {} })
      await expect(first.initialize()).resolves.toMatchObject({ revision: 3 })
      const second = new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: tamperedSnapshot, publishInvalidation: () => {} })
      await expect(second.initialize()).resolves.toMatchObject({ revision: 3 })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('serializes concurrent update and delete without resurrecting a removed skill', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-serial-update-'))
    try {
      const manager = new SkillManager(dir); await manager.initializeLoadOnly()
      const snapshot = () => ({ skills: manager.runtimeSemanticEntries(), storage: manager.semanticMigrationState() })
      const coordinator = new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: snapshot, publishInvalidation: () => {} })
      manager.setSemanticSnapshotProvider(snapshot)
      manager.setMutationRunner((domains, preview, apply) => coordinator.mutateComputed(domains, preview, apply).then(() => undefined))
      await coordinator.initialize()
      const entry = await manager.create({ name: 'serial', description: 'serial', content: skill('serial') })
      await Promise.all([manager.update(entry.id, { content: skill('serial', 'updated') }), manager.delete(entry.id)])
      expect(manager.get(entry.id)).toBeUndefined()
      await expect(fs.access(path.join(dir, 'skills', 'serial'))).rejects.toThrow()
      const replacement = await manager.create({ name: 'serial', description: 'serial', content: skill('serial', 'replacement') })
      expect(replacement.name).toBe('serial')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('rejects a stale same-revision journal receipt with a different mutation id', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-receipt-'))
    try {
      const manager = new SkillManager(dir); await manager.initializeLoadOnly()
      const coordinator = new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: () => ({ skills: manager.runtimeSemanticEntries(), storage: manager.semanticMigrationState() }), publishInvalidation: () => {} })
      await coordinator.initialize()
      const journalDir = path.join(dir, 'skills', '.transactions'); await fs.mkdir(journalDir, { recursive: true })
      const fake = { schema_version: 1, domain: 'skills', mutation_id: '11111111-1111-4111-8111-111111111111', target_revision: 2, before_registry_sha256: 'a'.repeat(64), after_registry_sha256: 'a'.repeat(64), staged_registry_rel: '.transactions/missing.json', staged_registry_sha256: 'a'.repeat(64), before_runtime_hashes: {}, after_runtime_hashes: {}, before_target_rel: '.transactions/a', after_target_rel: '.transactions/a', before_target_existed: false, stage_rel: '.transactions/a' }
      await fs.writeFile(path.join(journalDir, 'skill-source-journal.json'), JSON.stringify(fake))
      await expect(manager.recoverSourceJournal(coordinator)).rejects.toThrow()
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('rejects a journal that aliases a managed target as operation staging', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-journal-path-'))
    try {
      const victimDir = path.join(dir, 'skills', 'victim')
      await fs.mkdir(victimDir, { recursive: true })
      await fs.writeFile(path.join(victimDir, 'SKILL.md'), skill('victim'))
      const registry = Buffer.from(JSON.stringify([{
        id: 'victim-id', name: 'victim', description: 'victim', version: '1', skill_dir: victimDir,
        source_type: 'imported', is_builtin: false, is_essential: false, can_disable: true, enabled: true,
        created_at: 't', updated_at: 't',
      }], null, 2))
      await fs.writeFile(path.join(dir, 'skills.json'), registry)
      const digest = createHash('sha256').update(registry).digest('hex')
      const journalDir = path.join(dir, 'skills', '.transactions')
      await fs.mkdir(journalDir, { recursive: true })
      await fs.writeFile(path.join(journalDir, 'skill-source-journal.json'), JSON.stringify({
        schema_version: 1, domain: 'skills', mutation_id: '11111111-1111-4111-8111-111111111111', target_revision: 2,
        before_registry_sha256: digest, after_registry_sha256: digest,
        staged_registry_rel: '.transactions/registry-111111111111111111111111.json', staged_registry_sha256: digest,
        before_runtime_hashes: {}, after_runtime_hashes: {}, before_target_rel: 'victim', after_target_rel: 'victim',
        before_target_existed: true, stage_rel: 'victim',
      }))
      await expect(new SkillManager(dir).initializeLoadOnly()).rejects.toThrow('Invalid skill transaction path')
      await expect(fs.readFile(path.join(victimDir, 'SKILL.md'), 'utf8')).resolves.toContain('victim')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('migrates an external legacy source through a coordinator transaction', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-legacy-external-'))
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-external-source-'))
    try {
      await fs.writeFile(path.join(external, 'SKILL.md'), skill('external', 'external-body'))
      await fs.writeFile(path.join(dir, 'skills.json'), JSON.stringify([{
        id: 'external-id', name: 'external', description: 'external', version: '1', skill_dir: external,
        source_type: 'imported', is_builtin: false, is_essential: false, can_disable: true, enabled: true,
        created_at: 't', updated_at: 't',
      }]))
      const manager = new SkillManager(dir); await manager.initializeLoadOnly()
      const snapshot = () => ({ skills: manager.runtimeSemanticEntries(), storage: manager.semanticMigrationState() })
      const coordinator = new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: snapshot, publishInvalidation: () => {} })
      manager.setSemanticSnapshotProvider(snapshot)
      manager.setMutationRunner((domains, preview, apply) => coordinator.mutateComputed(domains, preview, apply).then(() => undefined))
      await coordinator.initialize(); await manager.initializeMigrations()
      const migrated = manager.get('external-id')!
      expect(migrated.skill_dir).toBe(path.join(dir, 'skills', 'external'))
      await expect(fs.readFile(path.join(migrated.skill_dir, 'SKILL.md'), 'utf8')).resolves.toContain('external-body')
      await expect(fs.readFile(path.join(external, 'SKILL.md'), 'utf8')).resolves.toContain('external-body')
      expect((await coordinator.current()).revision).toBe(2)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
      await fs.rm(external, { recursive: true, force: true })
    }
  })

  it('migrates embedded content and snapshot files through the coordinator without leaking bodies', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-legacy-coordinator-'))
    try {
      const marker = 'UNIQUE_LEGACY_BODY_MARKER'
      await fs.writeFile(path.join(dir, 'skills.json'), JSON.stringify([{
        id: 'legacy-id', name: 'legacy', description: 'legacy', version: '1', content: skill('legacy', marker),
        source_type: 'imported', is_builtin: false, is_essential: false, can_disable: true, enabled: true,
        created_at: 't', updated_at: 't', previous_snapshot: { content: skill('legacy', 'previous'), files: { 'references/a.md': 'ref' }, version: '0', updated_at: 't', snapshotted_at: '2026-01-01T00:00:00.000Z' },
      }]))
      const manager = new SkillManager(dir); await manager.initializeLoadOnly()
      const snapshot = () => ({ skills: manager.runtimeSemanticEntries(), storage: manager.semanticMigrationState() })
      const coordinator = new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: snapshot, publishInvalidation: () => {} })
      manager.setSemanticSnapshotProvider(snapshot)
      manager.setMutationRunner((domains, preview, apply) => coordinator.mutateComputed(domains, preview, apply).then(() => undefined))
      await coordinator.initialize(); await manager.initializeMigrations()
      const entry = manager.get('legacy-id')!
      expect(await fs.readFile(path.join(entry.skill_dir, 'SKILL.md'), 'utf8')).toContain(marker)
      expect(await fs.readFile(path.join(dir, 'skills', entry.previous_snapshot!.snapshot_dir, 'references/a.md'), 'utf8')).toBe('ref')
      expect((await coordinator.current()).revision).toBe(2)
      const persisted = await fs.readFile(path.join(dir, 'skills.json'), 'utf8')
      expect(persisted).not.toContain(marker)
      const transaction = await fs.readdir(path.join(dir, 'skills', '.transactions'))
      expect(transaction.join(',')).not.toContain(marker)
      expect((await fs.readdir(dir)).filter((name) => name.startsWith('skills.json.bak-'))).toHaveLength(1)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('rejects traversal in embedded legacy snapshot files before any authoritative write', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-legacy-traversal-'))
    try {
      const original = JSON.stringify([{ id: 'legacy-id', name: 'legacy', description: 'legacy', version: '1', content: skill('legacy'), source_type: 'imported', is_builtin: false, is_essential: false, can_disable: true, enabled: true, created_at: 't', updated_at: 't', previous_snapshot: { content: 'old', files: { '../escape': 'bad' }, version: '0', updated_at: 't', snapshotted_at: '2026-01-01T00:00:00.000Z' } }])
      await fs.writeFile(path.join(dir, 'skills.json'), original)
      const manager = new SkillManager(dir); await manager.initializeLoadOnly()
      await expect(manager.initializeMigrations()).rejects.toThrow('Invalid legacy snapshot file path')
      expect(await fs.readFile(path.join(dir, 'skills.json'), 'utf8')).toBe(original)
      await expect(fs.access(path.join(dir, 'skills', 'legacy'))).rejects.toThrow()
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('rejects duplicate planned legacy destinations before preparing a generic mutation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-legacy-duplicate-'))
    try {
      const entries = ['one', 'two'].map((id) => ({
        id, name: 'duplicate', description: id, version: '1', content: skill('duplicate', id),
        source_type: 'imported', is_builtin: false, is_essential: false, can_disable: true, enabled: true,
        created_at: 't', updated_at: 't',
      }))
      await fs.writeFile(path.join(dir, 'skills.json'), JSON.stringify(entries))
      const manager = new SkillManager(dir); await manager.initializeLoadOnly()
      let prepared = false
      const snapshot = () => ({ skills: manager.runtimeSemanticEntries(), storage: manager.semanticMigrationState() })
      const coordinator = new CoreAgentConfigMutationCoordinator(dir, {
        readSemanticSnapshot: snapshot,
        publishInvalidation: () => {},
        hooks: { afterPrepared: () => { prepared = true } },
      })
      manager.setSemanticSnapshotProvider(snapshot)
      manager.setMutationRunner((domains, preview, apply) => coordinator.mutateComputed(domains, preview, apply).then(() => undefined))
      await coordinator.initialize()
      await expect(manager.initializeMigrations()).rejects.toThrow('Legacy skill target collision')
      expect(prepared).toBe(false)
      expect((await coordinator.current()).revision).toBe(1)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('fails identical legacy target collisions without changing source or registry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-legacy-collision-'))
    try {
      const source = path.join(dir, 'old-source')
      const target = path.join(dir, 'skills', 'legacy')
      await fs.mkdir(source, { recursive: true }); await fs.mkdir(target, { recursive: true })
      await fs.writeFile(path.join(source, 'SKILL.md'), skill('legacy', 'same'))
      await fs.writeFile(path.join(target, 'SKILL.md'), skill('legacy', 'same'))
      const original = JSON.stringify([{ id: 'legacy-id', name: 'legacy', description: 'legacy', version: '1', skill_dir: source, source_type: 'imported', is_builtin: false, is_essential: false, can_disable: true, enabled: true, created_at: 't', updated_at: 't' }])
      await fs.writeFile(path.join(dir, 'skills.json'), original)
      const manager = new SkillManager(dir); await manager.initializeLoadOnly()
      await expect(manager.initializeMigrations()).rejects.toThrow('Legacy skill target collision')
      expect(await fs.readFile(path.join(dir, 'skills.json'), 'utf8')).toBe(original)
      await expect(fs.readFile(path.join(source, 'SKILL.md'), 'utf8')).resolves.toContain('same')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('renames an internal UUID snapshot with its legacy skill directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-legacy-uuid-'))
    try {
      const source = path.join(dir, 'skills', 'uuid-old')
      const oldSnapshot = path.join(dir, 'skills', '.snapshots', 'uuid-old-2026-01-01T00-00-00-000Z')
      await fs.mkdir(source, { recursive: true }); await fs.mkdir(oldSnapshot, { recursive: true })
      await fs.writeFile(path.join(source, 'SKILL.md'), skill('renamed', 'current'))
      await fs.writeFile(path.join(oldSnapshot, 'SKILL.md'), skill('renamed', 'previous'))
      await fs.writeFile(path.join(dir, 'skills.json'), JSON.stringify([{ id: 'legacy-id', name: 'renamed', description: 'renamed', version: '1', skill_dir: source, source_type: 'imported', is_builtin: false, is_essential: false, can_disable: true, enabled: true, created_at: 't', updated_at: 't', previous_snapshot: { snapshot_dir: '.snapshots/uuid-old-2026-01-01T00-00-00-000Z', version: '0', updated_at: 't', snapshotted_at: '2026-01-01T00:00:00.000Z' } }]))
      const manager = new SkillManager(dir); await manager.initializeLoadOnly(); await manager.initializeMigrations()
      const entry = manager.get('legacy-id')!
      expect(entry.skill_dir).toBe(path.join(dir, 'skills', 'renamed'))
      expect(entry.previous_snapshot?.snapshot_dir).toBe('.snapshots/renamed-2026-01-01T00-00-00-000Z')
      await expect(fs.readFile(path.join(dir, 'skills', entry.previous_snapshot!.snapshot_dir, 'SKILL.md'), 'utf8')).resolves.toContain('previous')
      await expect(fs.access(oldSnapshot)).rejects.toThrow()
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('serializes concurrent creates without losing either registry entry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-skill-serial-'))
    try {
      const manager = new SkillManager(dir); await manager.initializeLoadOnly()
      const coordinator = new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: () => ({ skills: manager.runtimeSemanticEntries(), storage: manager.semanticMigrationState() }), publishInvalidation: () => {} })
      manager.setSemanticSnapshotProvider(() => ({ skills: manager.runtimeSemanticEntries(), storage: manager.semanticMigrationState() }))
      manager.setMutationRunner((domains, preview, apply) => coordinator.mutateComputed(domains, preview, apply).then(() => undefined))
      await coordinator.initialize()
      await Promise.all(['one', 'two'].map((name) => manager.create({ name, description: name, content: skill(name) })))
      expect(manager.list().map((entry) => entry.name).sort()).toEqual(['one', 'two'])
      expect((await coordinator.current()).revision).toBe(3)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
