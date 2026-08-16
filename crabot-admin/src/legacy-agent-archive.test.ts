/**
 * P6-D：LegacyAgentArchiveStore 测试（protocol-admin §3.18）。
 * 覆盖：summary 无 raw、export 脱敏、delete 的 selection/confirmation/tombstone/journal/core 保护。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { LegacyAgentArchiveStore, LegacyAgentArchiveError } from './legacy-agent-archive.js'

const RECORDS = [
  {
    archive_id: 'agent_config:front-agent',
    source_kind: 'agent_config',
    source_id: 'front-agent',
    archived_at: '2026-08-14T00:00:00.000Z',
    support_status: 'unsupported_legacy',
    raw: { instance_id: 'front-agent', system_prompt: 'x', model_config: { powerful: { provider_id: 'p', model_id: 'm', api_key: 'sk-secret' } }, nickname: '保留未知字段' },
  },
  {
    archive_id: 'agent_instance:worker-general',
    source_kind: 'agent_instance',
    source_id: 'worker-general',
    archived_at: '2026-08-14T00:00:00.000Z',
    support_status: 'unsupported_legacy',
    raw: { id: 'worker-general', name: 'Worker', implementation_id: 'default' },
  },
]

describe('LegacyAgentArchiveStore', () => {
  let dir: string
  let store: LegacyAgentArchiveStore

  beforeEach(async () => {
    dir = path.join(process.cwd(), 'test-data', `archive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await fs.mkdir(path.join(dir, 'agent-configs'), { recursive: true })
    await fs.writeFile(path.join(dir, 'legacy-agent-archive.json'), JSON.stringify(RECORDS, null, 2))
    await fs.writeFile(path.join(dir, 'agent-configs', 'front-agent.json'), JSON.stringify(RECORDS[0].raw))
    store = new LegacyAgentArchiveStore(dir)
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('summary 列表不含 raw/secret，且带 uninstallable/display_name', async () => {
    const items = await store.listSummaries()
    expect(items).toHaveLength(2)
    const cfg = items.find((i) => i.archive_id === 'agent_config:front-agent')!
    expect(cfg.support_status).toBe('unsupported_legacy')
    expect(cfg.uninstallable).toBe(true)
    expect(cfg.display_name).toBe('front-agent')
    expect(JSON.stringify(items)).not.toContain('sk-secret')
    expect(JSON.stringify(items)).not.toContain('"raw"')
  })

  it('export 返回脱敏 raw（secret 打码、未知字段保留）', async () => {
    const record = await store.exportRecord('agent_config:front-agent') as { raw: Record<string, unknown> }
    expect(JSON.stringify(record.raw)).not.toContain('sk-secret')
    expect((record.raw as { nickname?: string }).nickname).toBe('保留未知字段')
    await expect(store.exportRecord('nope')).rejects.toMatchObject({ code: 'ADMIN_LEGACY_AGENT_ARCHIVE_NOT_FOUND', httpStatus: 404 })
  })

  it('false/false selection → 400 且零写', async () => {
    await expect(store.deleteArchive('agent_config:front-agent', { confirmation: 'agent_config:front-agent', delete_package: false, delete_config: false }))
      .rejects.toMatchObject({ code: 'ADMIN_LEGACY_AGENT_DELETE_SELECTION_REQUIRED' })
    expect(await fs.readFile(path.join(dir, 'agent-configs', 'front-agent.json'), 'utf8')).toContain('front-agent')
    await expect(fs.stat(path.join(dir, 'legacy-agent-tombstones.json'))).rejects.toThrow()
  })

  it('confirmation 不匹配 → 400', async () => {
    await expect(store.deleteArchive('agent_config:front-agent', { confirmation: 'wrong', delete_package: false, delete_config: true }))
      .rejects.toMatchObject({ code: 'ADMIN_LEGACY_AGENT_CONFIRMATION_MISMATCH' })
  })

  it('部分删除（只删 config、record 仍有 package 资源）→ archive_removed=false，summary 保留；同 selection 重试返回同一结果', async () => {
    // 构造一个同时有 package 与 config 资源的 record
    const pkgDir = path.join(dir, 'installed-modules', 'legacy-pkg')
    await fs.mkdir(pkgDir, { recursive: true })
    const both = {
      archive_id: 'installed_package:legacy-pkg',
      source_kind: 'installed_package',
      source_id: 'legacy-pkg',
      archived_at: '2026-08-14T00:00:00.000Z',
      support_status: 'unsupported_legacy',
      raw: { id: 'legacy-pkg', instance_id: 'legacy-pkg', installed_path: pkgDir, name: 'Legacy Pkg' },
    }
    await fs.writeFile(path.join(dir, 'legacy-agent-archive.json'), JSON.stringify([...RECORDS, both], null, 2))
    await fs.writeFile(path.join(dir, 'agent-configs', 'legacy-pkg.json'), '{}')
    const first = await store.deleteArchive('installed_package:legacy-pkg', { confirmation: 'installed_package:legacy-pkg', delete_package: false, delete_config: true })
    expect(first.archive_removed).toBe(false)
    expect(first.deleted_resources).toEqual(['agent-configs/legacy-pkg.json'])
    expect(first.retained_resources).toEqual(['installed-modules/legacy-pkg'])
    await expect(fs.stat(pkgDir)).resolves.toBeTruthy()
    const items = await store.listSummaries()
    expect(items.some((i) => i.archive_id === 'installed_package:legacy-pkg')).toBe(true)
    const second = await store.deleteArchive('installed_package:legacy-pkg', { confirmation: 'installed_package:legacy-pkg', delete_package: false, delete_config: true })
    expect(second).toEqual(first)
  })

  it('路径穿越：installed_path 指向允许根外 → 该 package 资源不进入删除计划', async () => {
    const evil = {
      archive_id: 'installed_package:evil',
      source_kind: 'installed_package',
      source_id: 'evil',
      archived_at: 'x',
      support_status: 'unsupported_legacy',
      raw: { id: 'evil', installed_path: '/tmp/outside-crabot-root' },
    }
    await fs.writeFile(path.join(dir, 'legacy-agent-archive.json'), JSON.stringify([evil], null, 2))
    await fs.mkdir('/tmp/outside-crabot-root', { recursive: true })
    const result = await store.deleteArchive('installed_package:evil', { confirmation: 'installed_package:evil', delete_package: true, delete_config: true })
    // package 资源被拒（路径在允许根外）；config 逻辑资源在根内允许删除（文件不存在时 rm force 幂等）
    expect(result.deleted_resources).not.toContain('installed-modules/evil')
    expect(result.retained_resources).not.toContain('installed-modules/evil')
    await expect(fs.stat('/tmp/outside-crabot-root')).resolves.toBeTruthy()
    await fs.rm('/tmp/outside-crabot-root', { recursive: true, force: true })
  })

  it('archive_removed=true 后 record 从 archive 移除，重试从 tombstone 返回同一结果', async () => {
    const first = await store.deleteArchive('agent_config:front-agent', { confirmation: 'agent_config:front-agent', delete_package: true, delete_config: true })
    expect(first.archive_removed).toBe(true)
    const remaining = JSON.parse(await fs.readFile(path.join(dir, 'legacy-agent-archive.json'), 'utf8')) as Array<{ archive_id: string }>
    expect(remaining.map((r) => r.archive_id)).toEqual(['agent_instance:worker-general'])
    const retry = await store.deleteArchive('agent_config:front-agent', { confirmation: 'agent_config:front-agent', delete_package: true, delete_config: true })
    expect(retry).toEqual(first)
  })

  it('core/builtin 记录拒绝（403）', async () => {
    const core = { archive_id: 'agent_instance:crabot-agent', source_kind: 'agent_instance', source_id: 'crabot-agent', archived_at: 'x', support_status: 'unsupported_legacy', raw: { id: 'crabot-agent' } }
    await fs.writeFile(path.join(dir, 'legacy-agent-archive.json'), JSON.stringify([...RECORDS, core], null, 2))
    await expect(store.deleteArchive('agent_instance:crabot-agent', { confirmation: 'agent_instance:crabot-agent', delete_package: false, delete_config: true }))
      .rejects.toMatchObject({ code: 'ADMIN_LEGACY_AGENT_CORE_PROTECTED', httpStatus: 403 })
  })

  it('crash 恢复：prepared journal 存在时续跑完成', async () => {
    await fs.mkdir(path.join(dir, 'migrations'), { recursive: true })
    await fs.writeFile(path.join(dir, 'migrations', 'legacy-agent-uninstall-journal.json'), JSON.stringify({
      archive_id: 'agent_config:front-agent',
      phase: 'prepared',
      delete_package: false,
      delete_config: true,
      targets: [{ logical: 'agent-configs/front-agent.json', absPath: path.join(dir, 'agent-configs', 'front-agent.json') }],
      deleted: [],
      updated_at: new Date().toISOString(),
    }))
    const result = await store.deleteArchive('agent_config:front-agent', { confirmation: 'agent_config:front-agent', delete_package: false, delete_config: true })
    expect(result.completed).toBe(true)
    await expect(fs.stat(path.join(dir, 'agent-configs', 'front-agent.json'))).rejects.toThrow()
    await expect(fs.stat(path.join(dir, 'migrations', 'legacy-agent-uninstall-journal.json'))).rejects.toThrow()
  })

  it('其它 archive 的未完成 journal → 冲突 409', async () => {
    await fs.mkdir(path.join(dir, 'migrations'), { recursive: true })
    await fs.writeFile(path.join(dir, 'migrations', 'legacy-agent-uninstall-journal.json'), JSON.stringify({
      archive_id: 'agent_instance:worker-general', phase: 'prepared', delete_package: false, delete_config: true,
      targets: [], deleted: [], updated_at: new Date().toISOString(),
    }))
    await expect(store.deleteArchive('agent_config:front-agent', { confirmation: 'agent_config:front-agent', delete_package: false, delete_config: true }))
      .rejects.toMatchObject({ code: 'ADMIN_LEGACY_AGENT_DELETE_CONFLICT' })
  })
})
