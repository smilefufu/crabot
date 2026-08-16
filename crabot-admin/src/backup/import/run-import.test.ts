import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import * as tar from 'tar'
import { runCrabotImport, type ImportDeps } from './run-import.js'

async function makeArchive(payload: Record<string, Record<string, unknown>>): Promise<string> {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'imp-run-'))
  await fs.writeFile(
    path.join(staging, 'manifest.json'),
    JSON.stringify({ schemaVersion: 1, product: 'crabot', categories: Object.keys(payload) }),
  )
  for (const [cat, files] of Object.entries(payload)) {
    await fs.mkdir(path.join(staging, 'payload', cat), { recursive: true })
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(staging, 'payload', cat, name), JSON.stringify(content))
    }
  }
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'imp-run-out-'))
  const archive = path.join(out, 'a.tar.gz')
  await tar.c({ gzip: true, file: archive, cwd: staging }, await fs.readdir(staging))
  return archive
}

describe('runCrabotImport', () => {
  it('tasks 类别逐条过 upsert 并汇总，结束调 finalize', async () => {
    const archive = await makeArchive({ tasks: { 'tasks.json': [{ id: 't1' }, { id: 't2' }] } })
    const upserted: string[] = []
    let finalized = false
    const deps: ImportDeps = {
      upsertTask: async (t) => { upserted.push((t as { id: string }).id); return 'imported' },
      finalize: async () => { finalized = true },
    }
    const summary = await runCrabotImport({
      archivePath: archive, categories: ['tasks'], onConflict: 'skip', deps,
    })
    expect(upserted).toEqual(['t1', 't2'])
    expect(summary.results.filter((r) => r.status === 'imported')).toHaveLength(2)
    expect(finalized).toBe(true)
  })

  it('未提供某类别 deps 时记 error 不崩', async () => {
    const archive = await makeArchive({ tasks: { 'tasks.json': [{ id: 't1' }] } })
    const summary = await runCrabotImport({
      archivePath: archive, categories: ['tasks'], onConflict: 'skip', deps: { finalize: async () => {} },
    })
    expect(summary.errors.length).toBeGreaterThan(0)
  })

  it('未选中的类别不处理', async () => {
    const archive = await makeArchive({ tasks: { 'tasks.json': [{ id: 't1' }] } })
    let called = false
    const summary = await runCrabotImport({
      archivePath: archive, categories: ['config'], onConflict: 'skip',
      deps: { upsertTask: async () => { called = true; return 'imported' }, finalize: async () => {} },
    })
    expect(called).toBe(false)
    expect(summary.results).toHaveLength(0)
  })

  it('upsert 抛错时该条记 failed，不中断其它条', async () => {
    const archive = await makeArchive({ tasks: { 'tasks.json': [{ id: 't1' }, { id: 't2' }] } })
    const deps: ImportDeps = {
      upsertTask: async (t) => {
        if ((t as { id: string }).id === 't1') throw new Error('boom')
        return 'imported'
      },
      finalize: async () => {},
    }
    const summary = await runCrabotImport({
      archivePath: archive, categories: ['tasks'], onConflict: 'skip', deps,
    })
    expect(summary.results.find((r) => r.id === 't1')?.status).toBe('failed')
    expect(summary.results.find((r) => r.id === 't2')?.status).toBe('imported')
  })

  it('importSkills 抛错时仍调 finalize 并记 error', async () => {
    const archive = await makeArchive({ skills: { 'skills.json': [{ id: 's1' }] } })
    let finalized = false
    const summary = await runCrabotImport({
      archivePath: archive, categories: ['skills'], onConflict: 'skip',
      deps: {
        importSkills: async () => { throw new Error('skill boom') },
        finalize: async () => { finalized = true },
      },
    })
    expect(finalized).toBe(true)
    expect(summary.errors.some((e) => e.includes('skills'))).toBe(true)
  })

  it('选中 channels 但缺 upsertChannel → 记 error', async () => {
    const archive = await makeArchive({
      channels: { 'channel-instances.json': [{ id: 'c1' }] },
    })
    const summary = await runCrabotImport({
      archivePath: archive, categories: ['channels'], onConflict: 'skip',
      deps: { finalize: async () => {} },
    })
    expect(summary.errors.some((e) => e.includes('channel'))).toBe(true)
  })
})

describe('runCrabotImport P6-D agent 分类（§3.18.1）', () => {
  it('含旧 live non-core instance → 整包 preflight 拒绝，任何 domain 零写入', async () => {
    const archive = await makeArchive({
      config: {
        'agent-instances.json': [{ id: 'front-agent' }],
        'model_providers.json': [{ id: 'p1' }],
      },
      tasks: { 'tasks.json': [{ id: 't1' }] },
    })
    const calls: string[] = []
    const deps: ImportDeps = {
      upsertProvider: async () => { calls.push('provider'); return 'imported' },
      upsertTask: async () => { calls.push('task'); return 'imported' },
      finalize: async () => { calls.push('finalize') },
    }
    await expect(runCrabotImport({ archivePath: archive, categories: ['config', 'tasks'], onConflict: 'skip', deps }))
      .rejects.toMatchObject({ code: 'ADMIN_BACKUP_NON_CORE_AGENT_UNSUPPORTED' })
    expect(calls).not.toContain('provider')
    expect(calls).not.toContain('task')
  })

  it('含旧 live implementation payload → 整包拒绝', async () => {
    const archive = await makeArchive({
      config: { 'agent-implementations.json': [{ id: 'custom-agent' }] },
    })
    await expect(runCrabotImport({ archivePath: archive, categories: ['config'], onConflict: 'skip', deps: { finalize: async () => {} } }))
      .rejects.toMatchObject({ code: 'ADMIN_BACKUP_NON_CORE_AGENT_UNSUPPORTED' })
  })

  it('只含 exact core instance → 通过 preflight，core config 走 importCoreAgentConfig', async () => {
    const archive = await makeArchive({
      config: { 'agent-instances.json': [{ id: 'crabot-agent' }] },
    })
    const calls: string[] = []
    const deps: ImportDeps = {
      validateAgentPayload: async () => { calls.push('validate'); return { coreConfigRaw: { instance_id: 'crabot-agent' }, archiveRows: [] } },
      applyCoreAgentConfig: async () => { calls.push('core-config'); return [{ kind: 'agent-config', id: 'crabot-agent', status: 'overwritten' }] },
      finalize: async () => {},
    }
    const summary = await runCrabotImport({ archivePath: archive, categories: ['config'], onConflict: 'skip', deps })
    expect(calls).toEqual(['validate', 'core-config'])
    expect(summary.errors).toEqual([])
  })

  it('新格式 legacy archive 经 ingestLegacyArchive 恢复', async () => {
    const archive = await makeArchive({
      config: { 'legacy-agent-archive.json': [{ archive_id: 'agent_config:old', source_kind: 'agent_config', source_id: 'old', archived_at: 'x', support_status: 'unsupported_legacy', raw: {} }] },
    })
    const calls: string[] = []
    const deps: ImportDeps = {
      validateAgentPayload: async () => ({ coreConfigRaw: null, archiveRows: [{ archive_id: 'agent_config:old' }] }),
      applyLegacyArchiveRows: async () => { calls.push('ingest'); return [{ kind: 'legacy-agent-archive', id: 'agent_config:old', status: 'imported' }] },
      finalize: async () => {},
    }
    await runCrabotImport({ archivePath: archive, categories: ['config'], onConflict: 'skip', deps })
    expect(calls).toEqual(['ingest'])
  })
})
