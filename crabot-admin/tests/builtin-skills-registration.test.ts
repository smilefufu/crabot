/**
 * 回归：release 包漏打 crabot-admin/builtins/skills/**\/SKILL.md（issue #43）
 *
 * 打包脚本的 `--exclude='*.md'` 只给 builtin-skills/ 开了 include 白名单，
 * builtins/skills/ 下的 SKILL.md 全被剔掉 → 目录还在、内容没了 →
 * registerBuiltins 逐个 `continue`，一条日志都不打，运行时只剩 4 个 seed skill。
 *
 * 这里锁两件事：
 *   1. 缺失形态（目录不存在 / 目录空壳）必须 fail loud，不能静默
 *   2. 仓库里每个 builtins/skills 子目录都带可解析的 SKILL.md
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkillManager } from '../src/mcp-skill-manager.js'
import { getBuiltinSkills } from '../src/builtin-skills.js'

const REPO_BUILTINS_DIR = join(__dirname, '..', 'builtins', 'skills')

function writeSkill(dir: string, name: string): void {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: desc ${name}\nversion: 1.0.0\n---\nbody\n`,
    'utf-8',
  )
}

describe('SkillManager.registerBuiltins', () => {
  let dataDir: string
  let builtinsDir: string
  let mgr: SkillManager
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'skill-builtins-data-'))
    builtinsDir = mkdtempSync(join(tmpdir(), 'skill-builtins-src-'))
    mgr = new SkillManager(dataDir)
    await mgr.initialize()
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errSpy.mockRestore()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(builtinsDir, { recursive: true, force: true })
  })

  it('注册所有含 SKILL.md 的子目录并返回数量', async () => {
    writeSkill(builtinsDir, 'review-skill')
    writeSkill(builtinsDir, 'tmp-page')

    const count = await mgr.registerBuiltins(builtinsDir)

    expect(count).toBe(2)
    expect(mgr.list().map((s) => s.name).sort()).toEqual(['review-skill', 'tmp-page'])
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('目录不存在 → 返回 0 且报错，不静默', async () => {
    const count = await mgr.registerBuiltins(join(builtinsDir, 'nope'))

    expect(count).toBe(0)
    expect(errSpy).toHaveBeenCalled()
    expect(errSpy.mock.calls.flat().join(' ')).toContain('nope')
  })

  it('子目录在但 SKILL.md 被打包剔掉（issue #43 形态）→ 返回 0 且报错', async () => {
    mkdirSync(join(builtinsDir, 'review-skill'), { recursive: true })
    mkdirSync(join(builtinsDir, 'tmp-page', 'scripts'), { recursive: true })
    writeFileSync(join(builtinsDir, 'tmp-page', 'scripts', 'server.cjs'), '// kept', 'utf-8')

    const count = await mgr.registerBuiltins(builtinsDir)

    expect(count).toBe(0)
    expect(mgr.list()).toHaveLength(0)
    expect(errSpy).toHaveBeenCalled()
  })
})

describe('仓库 builtins/skills 载荷', () => {
  it('每个子目录都有可解析 SKILL.md，且能全量注册', async () => {
    const dirs = readdirSync(REPO_BUILTINS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
    expect(dirs.length).toBeGreaterThan(0)
    for (const d of dirs) {
      expect(existsSync(join(REPO_BUILTINS_DIR, d, 'SKILL.md')), `${d} 缺 SKILL.md`).toBe(true)
    }

    const dataDir = mkdtempSync(join(tmpdir(), 'skill-builtins-repo-'))
    try {
      const mgr = new SkillManager(dataDir)
      await mgr.initialize()
      const count = await mgr.registerBuiltins(REPO_BUILTINS_DIR)
      expect(count).toBe(dirs.length)
      expect([
        ...getBuiltinSkills().map((skill) => skill.name),
        ...mgr.list().map((skill) => skill.name),
      ].sort()).toEqual([
        'tmp-page',
        'scrapling-official',
        'workspace-context-maintenance',
        'writing-plans',
        'systematic-debugging',
        'verification-before-completion',
        'memory-graph-linking',
        'crabot-cli',
      ].sort())
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
