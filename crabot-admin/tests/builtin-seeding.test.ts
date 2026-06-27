import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkillManager } from '../src/mcp-skill-manager.js'
import type { SkillRegistryEntry } from '../src/mcp-skill-manager.js'
import { getBuiltinSkills, BUILTIN_SKILL_IDS } from '../src/builtin-skills.js'
import { SubAgentManager } from '../src/subagent-manager.js'
import { getBuiltinSubAgents, BUILTIN_SUBAGENT_IDS } from '../src/builtin-subagents.js'
import type { SubAgentRegistryEntry } from '../src/types.js'

function makeEntry(id: string, name: string): SkillRegistryEntry {
  return {
    id,
    name,
    description: `desc ${name}`,
    version: '1.0.0',
    skill_dir: `/tmp/fake-skill-dir/${name}`,
    source_type: 'builtin',
    is_builtin: true,
    is_essential: false,
    can_disable: true,
    enabled: true,
    created_at: '2026-05-18T00:00:00Z',
    updated_at: '2026-05-18T00:00:00Z',
  }
}

describe('SkillManager.seedBuiltinSkills', () => {
  let tmpDir: string
  let mgr: SkillManager

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skill-seed-'))
    mgr = new SkillManager(tmpDir)
    await mgr.initialize()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('空 registry 注入全部', async () => {
    await mgr.seedBuiltinSkills([makeEntry('builtin-a', 'a'), makeEntry('builtin-b', 'b')])
    expect(mgr.list().map((s) => s.id).sort()).toEqual(['builtin-a', 'builtin-b'])
  })

  it('已存在同 id 时跳过（不覆盖）', async () => {
    await mgr.seedBuiltinSkills([makeEntry('builtin-a', 'a-original')])
    await mgr.seedBuiltinSkills([makeEntry('builtin-a', 'a-overwrite')])
    expect(mgr.get('builtin-a')?.name).toBe('a-original')
  })

  it('文件持久化跨实例可读', async () => {
    await mgr.seedBuiltinSkills([makeEntry('builtin-c', 'c')])
    const mgr2 = new SkillManager(tmpDir)
    await mgr2.initialize()
    expect(mgr2.get('builtin-c')?.name).toBe('c')
  })
})

describe('getBuiltinSkills', () => {
  it('返回 3 个 builtin skill', () => {
    const list = getBuiltinSkills()
    expect(list).toHaveLength(3)
    expect(list.map((s) => s.id).sort()).toEqual([
      BUILTIN_SKILL_IDS.writingPlans,
      BUILTIN_SKILL_IDS.systematicDebugging,
      BUILTIN_SKILL_IDS.verificationBeforeCompletion,
    ].sort())
  })

  it('skill_dir 指向真实目录且 SKILL.md 含 attribution header', () => {
    for (const s of getBuiltinSkills()) {
      expect(s.skill_dir).toBeTruthy()
      const skillMd = readFileSync(join(s.skill_dir, 'SKILL.md'), 'utf-8')
      expect(skillMd.length).toBeGreaterThan(100)
      expect(skillMd).toContain('Source: superpowers v5.0.7')
    }
  })

  it('全部 is_builtin=true + enabled=true', () => {
    for (const s of getBuiltinSkills()) {
      expect(s.is_builtin).toBe(true)
      expect(s.enabled).toBe(true)
    }
  })
})

describe('getBuiltinSubAgents', () => {
  it('返回 6 个 builtin subagent', () => {
    const list = getBuiltinSubAgents()
    expect(list).toHaveLength(6)
    expect(list.map((s) => s.id).sort()).toEqual([
      BUILTIN_SUBAGENT_IDS.codePlanner,
      BUILTIN_SUBAGENT_IDS.codeWriter,
      BUILTIN_SUBAGENT_IDS.researchCollector,
      BUILTIN_SUBAGENT_IDS.goalAuditor,
      BUILTIN_SUBAGENT_IDS.specReviewer,
      BUILTIN_SUBAGENT_IDS.codeQualityReviewer,
    ].sort())
  })

  it('全部 is_builtin=true + enabled=true', () => {
    for (const s of getBuiltinSubAgents()) {
      expect(s.is_builtin).toBe(true)
      expect(s.enabled).toBe(true)
    }
  })

  it('code_planner 使用 powerful role + 挂 writing-plans skill', () => {
    const p = getBuiltinSubAgents().find((s) => s.name === 'code_planner')!
    expect(p.model_role).toBe('powerful')
    expect(p.allowed_skill_ids).toContain(BUILTIN_SKILL_IDS.writingPlans)
  })

  it('code_writer 使用 cost_effective role + 挂 systematic-debugging + verification-before-completion', () => {
    const w = getBuiltinSubAgents().find((s) => s.name === 'code_writer')!
    expect(w.model_role).toBe('cost_effective')
    expect(w.allowed_skill_ids).toContain(BUILTIN_SKILL_IDS.systematicDebugging)
    expect(w.allowed_skill_ids).toContain(BUILTIN_SKILL_IDS.verificationBeforeCompletion)
  })

  it('code_writer 挂 lsp_diagnostics 预设（post-edit 自动诊断 push）', () => {
    const w = getBuiltinSubAgents().find((s) => s.name === 'code_writer')!
    expect(w.hook_preset).toBe('lsp_diagnostics')
  })

  it('research_collector 使用 vision role + 通用调查员 capabilities 全开', () => {
    // memory: feedback_research_collector_is_general — 2026-05-21 把 capabilities 全开恢复
    // 原意（通用调查员，不是 web 专科），断言同步跟上代码 entry。
    const r = getBuiltinSubAgents().find((s) => s.name === 'research_collector')!
    expect(r.model_role).toBe('vision')
    expect(r.builtin_capabilities.file_system).toBe(true)
    expect(r.builtin_capabilities.crab_memory).toBe(true)
    // scrapling 是调研用的 web mcp（workflow 明列要用），此前白名单为空导致调研根本调不到，已修。
    expect(r.allowed_mcp_server_ids).toContain('scrapling')
  })

  it('allowed_mcp_server_ids 按 MCP server name 开放（lsp/git/scrapling 内置 MCP）', () => {
    // 注意：白名单按 server **name** 匹配（运行时工具名 mcp__<name>__*），不是 id；
    // 内置 server 的 id 每实例随机（generateId），代码只能按 name 引用。
    const byName = Object.fromEntries(
      getBuiltinSubAgents().map((s) => [s.name, s.allowed_mcp_server_ids]),
    )
    expect(byName.code_planner).toEqual(['lsp', 'git'])
    expect(byName.code_writer).toEqual(['lsp', 'git'])
    expect(byName.research_collector).toEqual(['scrapling', 'lsp', 'git'])
    expect(byName.goal_auditor).toEqual(['git'])
    expect(byName.spec_reviewer).toEqual(['git'])
    expect(byName.code_quality_reviewer).toEqual(['lsp', 'git'])
  })
})

describe('SubAgentManager.seedBuiltin via getBuiltinSubAgents', () => {
  let tmpDir2: string
  let mgr2: SubAgentManager

  beforeEach(async () => {
    tmpDir2 = mkdtempSync(join(tmpdir(), 'subagent-seed-e2e-'))
    mgr2 = new SubAgentManager(tmpDir2)
    await mgr2.initialize()
  })

  afterEach(() => {
    rmSync(tmpDir2, { recursive: true, force: true })
  })

  it('空 registry 注入全 6 个', async () => {
    await mgr2.seedBuiltin(getBuiltinSubAgents())
    expect(mgr2.list()).toHaveLength(6)
  })

  it('idempotent — 第二次调用不变', async () => {
    await mgr2.seedBuiltin(getBuiltinSubAgents())
    await mgr2.seedBuiltin(getBuiltinSubAgents())
    expect(mgr2.list()).toHaveLength(6)
  })
})

describe('SubAgentManager.pruneObsoleteBuiltins', () => {
  let tmpDir3: string
  let mgr3: SubAgentManager

  beforeEach(async () => {
    tmpDir3 = mkdtempSync(join(tmpdir(), 'subagent-prune-'))
    mgr3 = new SubAgentManager(tmpDir3)
    await mgr3.initialize()
  })

  afterEach(() => {
    rmSync(tmpDir3, { recursive: true, force: true })
  })

  it('删除 is_builtin=true 但不在 active list 的 entry', async () => {
    const seedTs = '2026-05-19T00:00:00.000Z'
    await mgr3.seedBuiltin([
      {
        id: 'builtin-obsolete', name: 'obsolete', description: '', when_to_use: '', role: '', workflow: '', deliverables: '',
        provider_id: null, model_id: null, model_role: 'vision',
        builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
        allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 10,
        enabled: true, is_builtin: true, created_at: seedTs, updated_at: seedTs,
      },
      {
        id: 'builtin-active', name: 'active', description: '', when_to_use: '', role: '', workflow: '', deliverables: '',
        provider_id: null, model_id: null, model_role: 'powerful',
        builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
        allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 10,
        enabled: true, is_builtin: true, created_at: seedTs, updated_at: seedTs,
      },
    ])
    expect(mgr3.list()).toHaveLength(2)

    await mgr3.pruneObsoleteBuiltins(['builtin-active'])
    expect(mgr3.list().map((e) => e.id)).toEqual(['builtin-active'])
  })

  it('不删除非 builtin 项（即使不在 active list）', async () => {
    await mgr3.create({
      name: 'user-custom', description: '', when_to_use: 'x', role: 'r', workflow: 'w', deliverables: 'd',
      provider_id: 'p', model_id: 'm', model_role: null,
      builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
      allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 10,
    })
    const userId = mgr3.list()[0].id

    await mgr3.pruneObsoleteBuiltins(['builtin-active'])
    expect(mgr3.list()).toHaveLength(1)
    expect(mgr3.list()[0].id).toBe(userId)
  })

  it('active list 为空时仍正常工作（删全部 builtin）', async () => {
    const seedTs = '2026-05-19T00:00:00.000Z'
    await mgr3.seedBuiltin([
      {
        id: 'builtin-a', name: 'a', description: '', when_to_use: '', role: '', workflow: '', deliverables: '',
        provider_id: null, model_id: null, model_role: 'vision',
        builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
        allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 10,
        enabled: true, is_builtin: true, created_at: seedTs, updated_at: seedTs,
      },
    ])

    await mgr3.pruneObsoleteBuiltins([])
    expect(mgr3.list()).toHaveLength(0)
  })

  it('空 registry 不报错', async () => {
    await expect(mgr3.pruneObsoleteBuiltins(['builtin-a'])).resolves.not.toThrow()
  })

  it('无需删除时不调 save（活动状态不变）', async () => {
    const seedTs = '2026-05-19T00:00:00.000Z'
    await mgr3.seedBuiltin([
      {
        id: 'builtin-x', name: 'x', description: '', when_to_use: '', role: '', workflow: '', deliverables: '',
        provider_id: null, model_id: null, model_role: 'vision',
        builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
        allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 10,
        enabled: true, is_builtin: true, created_at: seedTs, updated_at: seedTs,
      },
    ])

    await mgr3.pruneObsoleteBuiltins(['builtin-x'])
    expect(mgr3.list().map((e) => e.id)).toEqual(['builtin-x'])
  })
})

describe('SubAgentManager v2 override 存储', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'subagent-v2-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('v1 裸数组格式 load 时自动迁移到 v2 + 备份原文件', async () => {
    // 模拟当前线上磁盘格式：v1 裸数组 + builtin 全量字段（含旧 max_turns=15）
    const { writeFileSync, readdirSync, readFileSync } = await import('fs')
    const filePath = join(tmpDir, 'subagents.json')
    const legacy = getBuiltinSubAgents().map((e) => ({ ...e, max_turns: 15 }))
    writeFileSync(filePath, JSON.stringify(legacy, null, 2))

    const mgr = new SubAgentManager(tmpDir, getBuiltinSubAgents)
    await mgr.initialize()

    // 备份文件已落盘
    const files = readdirSync(tmpDir)
    expect(files.some((f) => f.startsWith('.legacy-subagents-'))).toBe(true)

    // builtin 内容字段被代码默认值覆盖（commit ecb87a3 起全局对齐 300——
    // 避免触顶 fail loud；任务过载靠 BLOCKED + TASK_TOO_LARGE 信号上报由 main 拆细）
    const goalAuditor = mgr.list().find((e) => e.name === 'goal_auditor')!
    expect(goalAuditor.max_turns).toBe(300)
    const codePlanner = mgr.list().find((e) => e.name === 'code_planner')!
    expect(codePlanner.max_turns).toBe(300)

    // 磁盘已重写为 v2 格式
    const reread = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(reread.version).toBe(2)
    expect(Array.isArray(reread.entries)).toBe(true)
  })

  it('save 后 builtin 仅落 state 字段（未 override 时不写内容字段）', async () => {
    const { readFileSync } = await import('fs')
    const mgr = new SubAgentManager(tmpDir, getBuiltinSubAgents)
    await mgr.initialize()
    await mgr.seedBuiltin(getBuiltinSubAgents())

    const stored = JSON.parse(readFileSync(join(tmpDir, 'subagents.json'), 'utf-8'))
    const auditorOnDisk = stored.entries.find((e: { id: string }) => e.id === 'builtin-goal-auditor')
    expect(auditorOnDisk).toBeDefined()
    // 状态字段必须有
    expect(auditorOnDisk).toHaveProperty('id')
    expect(auditorOnDisk).toHaveProperty('enabled')
    expect(auditorOnDisk).toHaveProperty('created_at')
    // 与 codeDefault 相同的内容字段不应落盘
    expect(auditorOnDisk).not.toHaveProperty('role')
    expect(auditorOnDisk).not.toHaveProperty('max_turns')
    expect(auditorOnDisk).not.toHaveProperty('workflow')
  })

  it('用户 update max_turns → 仅 override 落盘 + 跨实例持久化', async () => {
    const { readFileSync } = await import('fs')
    const mgr = new SubAgentManager(tmpDir, getBuiltinSubAgents)
    await mgr.initialize()
    await mgr.seedBuiltin(getBuiltinSubAgents())

    await mgr.update('builtin-goal-auditor', { max_turns: 99 })

    const stored = JSON.parse(readFileSync(join(tmpDir, 'subagents.json'), 'utf-8'))
    const auditorOnDisk = stored.entries.find((e: { id: string }) => e.id === 'builtin-goal-auditor')
    expect(auditorOnDisk.max_turns).toBe(99)
    expect(auditorOnDisk).not.toHaveProperty('role')

    // 新实例 load 后看到的还是 99
    const mgr2 = new SubAgentManager(tmpDir, getBuiltinSubAgents)
    await mgr2.initialize()
    expect(mgr2.get('builtin-goal-auditor')?.max_turns).toBe(99)
  })

  it('codeDefault 升级后未 override 字段自动跟随', async () => {
    const { readFileSync } = await import('fs')

    // 先用旧 codeDefault seed
    const oldDefaults = (): SubAgentRegistryEntry[] =>
      getBuiltinSubAgents().map((e) =>
        e.id === 'builtin-goal-auditor' ? { ...e, max_turns: 15, role: 'OLD ROLE' } : e
      )
    const mgrOld = new SubAgentManager(tmpDir, oldDefaults)
    await mgrOld.initialize()
    await mgrOld.seedBuiltin(oldDefaults())

    // 磁盘上应该只存 state（max_turns / role 都和 oldDefault 一致，不落盘）
    const stored = JSON.parse(readFileSync(join(tmpDir, 'subagents.json'), 'utf-8'))
    const auditor = stored.entries.find((e: { id: string }) => e.id === 'builtin-goal-auditor')
    expect(auditor).not.toHaveProperty('max_turns')
    expect(auditor).not.toHaveProperty('role')

    // 升级到新 codeDefault（max_turns=50, role='NEW ROLE'）
    const newDefaults = (): SubAgentRegistryEntry[] =>
      getBuiltinSubAgents().map((e) =>
        e.id === 'builtin-goal-auditor' ? { ...e, max_turns: 50, role: 'NEW ROLE' } : e
      )
    const mgrNew = new SubAgentManager(tmpDir, newDefaults)
    await mgrNew.initialize()

    const merged = mgrNew.get('builtin-goal-auditor')!
    expect(merged.max_turns).toBe(50)
    expect(merged.role).toBe('NEW ROLE')
  })

  it('用户改过的字段不被代码升级覆盖（override 永久保留）', async () => {
    // 旧 codeDefault max_turns=15，user override 到 99
    const oldDefaults = (): SubAgentRegistryEntry[] =>
      getBuiltinSubAgents().map((e) =>
        e.id === 'builtin-goal-auditor' ? { ...e, max_turns: 15 } : e
      )
    const mgrOld = new SubAgentManager(tmpDir, oldDefaults)
    await mgrOld.initialize()
    await mgrOld.seedBuiltin(oldDefaults())
    await mgrOld.update('builtin-goal-auditor', { max_turns: 99 })

    // 代码升级 default 到 50；用户 override 99 应保留
    const newDefaults = (): SubAgentRegistryEntry[] =>
      getBuiltinSubAgents().map((e) =>
        e.id === 'builtin-goal-auditor' ? { ...e, max_turns: 50 } : e
      )
    const mgrNew = new SubAgentManager(tmpDir, newDefaults)
    await mgrNew.initialize()
    expect(mgrNew.get('builtin-goal-auditor')?.max_turns).toBe(99)
  })

  it('非 builtin entry 走全量落盘，行为不变', async () => {
    const { readFileSync } = await import('fs')
    const mgr = new SubAgentManager(tmpDir, getBuiltinSubAgents)
    await mgr.initialize()
    await mgr.create({
      name: 'user_custom',
      description: 'd',
      when_to_use: 'w',
      role: 'r',
      workflow: 'wf',
      deliverables: 'd',
      provider_id: 'p',
      model_id: 'm',
      model_role: null,
      builtin_capabilities: {
        file_system: false,
        shell: false,
        task_intel: false,
        crab_memory: false,
        crab_messaging: false,
      },
      allowed_mcp_server_ids: [],
      allowed_skill_ids: [],
      max_turns: 20,
    })
    const stored = JSON.parse(readFileSync(join(tmpDir, 'subagents.json'), 'utf-8'))
    const userEntry = stored.entries.find((e: { name: string }) => e.name === 'user_custom')
    expect(userEntry).toHaveProperty('role', 'r')
    expect(userEntry).toHaveProperty('max_turns', 20)
    expect(userEntry).toHaveProperty('workflow', 'wf')
  })
})

describe('getBuiltinSubAgents > goal_auditor', () => {
  it('goal_auditor 配置正确', () => {
    const g = getBuiltinSubAgents().find((s) => s.name === 'goal_auditor')
    expect(g).toBeDefined()
    if (!g) return
    expect(g.id).toBe('builtin-goal-auditor')
    expect(g.model_role).toBe('powerful')
    expect(g.max_turns).toBe(300)
    expect(g.system_only).toBe(true)
    expect(g.is_builtin).toBe(true)
    expect(g.enabled).toBe(true)
    expect(g.builtin_capabilities).toEqual({
      file_system: true,
      shell: true,
      task_intel: false,
      crab_memory: false,
      crab_messaging: false,
    })
    expect(g.allowed_skill_ids).toContain('builtin-skill-verification-before-completion')
  })

  it('goal_auditor 的 prompt 五段都齐全（tool call 协议）', () => {
    const g = getBuiltinSubAgents().find((s) => s.name === 'goal_auditor')!
    expect(g.role.length).toBeGreaterThan(100)
    expect(g.workflow.length).toBeGreaterThan(100)
    // tool call 协议：要求调 submit_audit_result，不再 emit AUDIT_RESULT 自由文本
    expect(g.deliverables).toContain('submit_audit_result')
    expect(g.deliverables).toMatch(/pass.*boolean|failed_criteria|evidence/)
    expect(g.verification).toBeTruthy()
    expect(g.verification).toContain('submit_audit_result')
    expect(g.when_to_use).toContain('system_only')
  })
})
