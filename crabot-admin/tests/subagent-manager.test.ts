import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SubAgentManager, resolveSubAgentModel } from '../src/subagent-manager.js'

describe('SubAgentManager', () => {
  let tmpDir: string
  let mgr: SubAgentManager

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'subagent-mgr-'))
    mgr = new SubAgentManager(tmpDir)
    await mgr.initialize()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('初始 list 为空', () => {
    expect(mgr.list()).toEqual([])
  })

  it('create + get + list', async () => {
    const entry = await mgr.create({
      name: 'web_researcher',
      description: '网页搜集',
      when_to_use: 'Use this subagent when ...',
      role: '你是 web 研究员',
      workflow: '1. 搜索 2. 综述',
      deliverables: '返回 markdown 报告',
      provider_id: 'prov-1',
      model_id: 'gpt-4',
      model_role: null,
      builtin_capabilities: { file_system: true, shell: true, task_intel: true, crab_memory: true, crab_messaging: false },
      allowed_mcp_server_ids: [],
      allowed_skill_ids: [],
      max_turns: 20,
    })
    expect(entry.id).toBeTruthy()
    expect(entry.name).toBe('web_researcher')
    expect(entry.is_builtin).toBe(false)
    expect(entry.enabled).toBe(true)
    expect(mgr.get(entry.id)).toEqual(entry)
    expect(mgr.list()).toHaveLength(1)
  })

  it('runtime snapshot 将旧 crab_memory=true 归一化为 false', async () => {
    await mgr.create({
      name: 'legacy_memory_child', description: '', when_to_use: '', role: '', workflow: '', deliverables: '',
      provider_id: 'p', model_id: 'm', model_role: null,
      builtin_capabilities: { file_system: true, shell: true, task_intel: true, crab_memory: true, crab_messaging: false },
      allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 20,
    })

    expect(mgr.runtimeSemanticEntries()).toEqual([
      expect.objectContaining({
        builtin_capabilities: expect.objectContaining({ crab_memory: false, crab_messaging: false }),
      }),
    ])
  })

  it('name 重复拒绝', async () => {
    const baseParams = {
      name: 'dup',
      description: '',
      when_to_use: '',
      role: '',
      workflow: '',
      deliverables: '',
      provider_id: 'p',
      model_id: 'm',
      model_role: null,
      builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
      allowed_mcp_server_ids: [],
      allowed_skill_ids: [],
      max_turns: 20,
    }
    await mgr.create(baseParams)
    await expect(mgr.create(baseParams)).rejects.toThrow(/已存在/)
  })

  it('update 修改 fields', async () => {
    const e = await mgr.create({ name: 'foo', description: 'a', when_to_use: 'x', role: 'r', workflow: 'w', deliverables: 'd', provider_id: 'p', model_id: 'm', model_role: null, builtin_capabilities: { file_system: true, shell: false, task_intel: false, crab_memory: false, crab_messaging: false }, allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 20 })
    const updated = await mgr.update(e.id, { description: 'b', max_turns: 30 })
    expect(updated.description).toBe('b')
    expect(updated.max_turns).toBe(30)
    // 时间戳单调不减（不依赖 wall clock 精度）
    expect(updated.updated_at >= e.updated_at).toBe(true)
  })

  it('delete 非内置项', async () => {
    const e = await mgr.create({ name: 'tmp', description: '', when_to_use: '', role: '', workflow: '', deliverables: '', provider_id: 'p', model_id: 'm', model_role: null, builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false }, allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 20 })
    await mgr.delete(e.id)
    expect(mgr.get(e.id)).toBeUndefined()
  })

  it('delete 内置项拒绝', async () => {
    await mgr.seedBuiltin([{
      id: 'builtin-x', name: 'x', description: '', when_to_use: '', role: '', workflow: '', deliverables: '',
      provider_id: null, model_id: null, model_role: 'powerful',
      builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
      allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 20,
      enabled: true, is_builtin: true, created_at: 't', updated_at: 't',
    }])
    await expect(mgr.delete('builtin-x')).rejects.toThrow(/不可删除/)
  })

  it('create 同时缺 provider_id+model_id 和 model_role 抛错', async () => {
    await expect(mgr.create({ name: 'bad', description: '', when_to_use: '', role: '', workflow: '', deliverables: '', provider_id: null, model_id: null, model_role: null, builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false }, allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 20 })).rejects.toThrow(/model spec 缺失/)
  })

  it('seedBuiltin 已存在则跳过', async () => {
    await mgr.seedBuiltin([{ id: 's1', name: 'seed1', description: '', when_to_use: '', role: '', workflow: '', deliverables: '', provider_id: null, model_id: null, model_role: 'powerful', builtin_capabilities: { file_system: true, shell: true, task_intel: true, crab_memory: true, crab_messaging: false }, allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 20, enabled: true, is_builtin: true, created_at: 't', updated_at: 't' }])
    await mgr.seedBuiltin([{ id: 's1', name: 'overwrite', description: 'NEW', when_to_use: '', role: '', workflow: '', deliverables: '', provider_id: null, model_id: null, model_role: 'powerful', builtin_capabilities: { file_system: true, shell: true, task_intel: true, crab_memory: true, crab_messaging: false }, allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 20, enabled: true, is_builtin: true, created_at: 't', updated_at: 't' }])
    expect(mgr.get('s1')?.name).toBe('seed1')   // 没被覆盖
  })

  it('文件持久化跨实例可读', async () => {
    const e = await mgr.create({ name: 'persist', description: '', when_to_use: '', role: '', workflow: '', deliverables: '', provider_id: 'p', model_id: 'm', model_role: null, builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false }, allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 20 })
    const mgr2 = new SubAgentManager(tmpDir)
    await mgr2.initialize()
    expect(mgr2.get(e.id)?.name).toBe('persist')
  })

  it('listEnabled 过滤 enabled=false', async () => {
    await mgr.create({ name: 'on', description: '', when_to_use: '', role: '', workflow: '', deliverables: '', provider_id: 'p', model_id: 'm', model_role: null, builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false }, allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 20 })
    const b = await mgr.create({ name: 'off', description: '', when_to_use: '', role: '', workflow: '', deliverables: '', provider_id: 'p', model_id: 'm', model_role: null, builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false }, allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 20 })
    await mgr.update(b.id, { enabled: false })
    const enabled = mgr.listEnabled()
    expect(enabled.map((entry) => entry.name)).toEqual(['on'])
    expect(mgr.list().map((entry) => entry.name).sort()).toEqual(['off', 'on'])
  })

  it('update 不存在的 id 抛错', async () => {
    await expect(mgr.update('nonexistent', { description: 'x' })).rejects.toThrow(/not found/)
  })

  it('update 改 name 撞别人时拒绝', async () => {
    await mgr.create({ name: 'alpha', description: '', when_to_use: '', role: '', workflow: '', deliverables: '', provider_id: 'p', model_id: 'm', model_role: null, builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false }, allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 20 })
    const b = await mgr.create({ name: 'beta', description: '', when_to_use: '', role: '', workflow: '', deliverables: '', provider_id: 'p', model_id: 'm', model_role: null, builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false }, allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 20 })
    await expect(mgr.update(b.id, { name: 'alpha' })).rejects.toThrow(/已存在/)
    // 改成自己原名应允许
    await expect(mgr.update(b.id, { name: 'beta' })).resolves.toBeTruthy()
  })
})

describe('resolveSubAgentModel', () => {
  it('provider_id+model_id 非 null 优先返回 specific', () => {
    const entry = { provider_id: 'p1', model_id: 'm1', model_role: 'powerful' as const }
    expect(resolveSubAgentModel(entry)).toEqual({ mode: 'specific', provider_id: 'p1', model_id: 'm1' })
  })

  it('provider_id 或 model_id 任一为 null 时走 role', () => {
    const entryA = { provider_id: null, model_id: 'm1', model_role: 'powerful' as const }
    expect(resolveSubAgentModel(entryA)).toEqual({ mode: 'role', role: 'powerful' })
    const entryB = { provider_id: 'p1', model_id: null, model_role: 'powerful' as const }
    expect(resolveSubAgentModel(entryB)).toEqual({ mode: 'role', role: 'powerful' })
  })

  it('只有 model_role 时返回 role mode', () => {
    const entry = { provider_id: null, model_id: null, model_role: 'cost_effective' as const }
    expect(resolveSubAgentModel(entry)).toEqual({ mode: 'role', role: 'cost_effective' })
  })

  it('都缺则抛错', () => {
    const entry = { provider_id: null, model_id: null, model_role: null }
    expect(() => resolveSubAgentModel(entry)).toThrow(/缺失/)
  })
})
