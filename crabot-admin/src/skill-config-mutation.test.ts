import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
      await recovered.initialize()
      await restarted.recoverSourceJournal(recovered)
      await expect(fs.access(journal)).rejects.toThrow()
      expect((await recovered.current()).revision).toBe(2)
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
      await expect(new CoreAgentConfigMutationCoordinator(dir, { readSemanticSnapshot: () => ({ skills: restarted.runtimeSemanticEntries(), storage: restarted.semanticMigrationState() }), publishInvalidation: () => {} }).initialize()).rejects.toThrow('semantic fingerprint does not match committed revision')
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
