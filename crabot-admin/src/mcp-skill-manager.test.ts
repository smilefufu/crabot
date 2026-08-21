import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import AdmZip from 'adm-zip'
import { SkillManager, MCPServerManager } from './mcp-skill-manager.js'
import type { MCPServerRegistryEntry } from './mcp-skill-manager.js'

describe('installSkillFromDirectory', () => {
  let tmpRoot: string
  let dataDir: string
  let manager: SkillManager

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-test-'))
    dataDir = path.join(tmpRoot, 'data')
    await fs.mkdir(dataDir, { recursive: true })
    manager = new SkillManager(dataDir)
    await manager.initialize()
  })

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('安装完整 skill 目录（含 scripts/references/assets）后所有文件落到 <data_dir>/skills/<name>/', async () => {
    const srcDir = path.join(tmpRoot, 'src-skill')
    await fs.mkdir(path.join(srcDir, 'scripts'), { recursive: true })
    await fs.mkdir(path.join(srcDir, 'references'), { recursive: true })
    await fs.writeFile(path.join(srcDir, 'SKILL.md'), `---\nname: test-skill\ndescription: desc\nversion: 1.0.0\n---\n# Body`)
    await fs.writeFile(path.join(srcDir, 'scripts', 'foo.py'), 'print("hi")')
    await fs.writeFile(path.join(srcDir, 'references', 'api.md'), '# API')

    const { entry } = await (manager as any).installSkillFromDirectory(srcDir, { source_type: 'imported', source_url: 'test://x' })

    const installedDir = path.join(dataDir, 'skills', entry.name)
    expect(await fs.readFile(path.join(installedDir, 'SKILL.md'), 'utf-8')).toContain('# Body')
    expect(await fs.readFile(path.join(installedDir, 'scripts', 'foo.py'), 'utf-8')).toBe('print("hi")')
    expect(await fs.readFile(path.join(installedDir, 'references', 'api.md'), 'utf-8')).toBe('# API')
    expect(entry.skill_dir).toBe(installedDir)
    expect(entry.source_url).toBe('test://x')
  })

  it('原子写：失败时不留半成品', async () => {
    const srcDir = path.join(tmpRoot, 'no-skill-md')
    await fs.mkdir(srcDir, { recursive: true })
    // 没有 SKILL.md
    await expect((manager as any).installSkillFromDirectory(srcDir, { source_type: 'imported' })).rejects.toThrow(/SKILL\.md/)
    const skillsRoot = path.join(dataDir, 'skills')
    const remaining = await fs.readdir(skillsRoot).catch(() => [])
    // 严格：连 .tmp.* 也不能留
    expect(remaining).toEqual([])
  })

  it('catch 块清掉 tmpDir：copyDir 中途 fs.copyFile 失败', async () => {
    const srcDir = path.join(tmpRoot, 'src-mid-fail')
    await fs.mkdir(srcDir, { recursive: true })
    await fs.writeFile(
      path.join(srcDir, 'SKILL.md'),
      `---\nname: midfail\ndescription: d\nversion: 1.0.0\n---\nbody`,
    )
    // mock fs.copyFile 让 copyDir 走到中途失败 → 触发 catch 块
    const spy = vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(new Error('disk full simulated'))
    try {
      await expect(
        (manager as any).installSkillFromDirectory(srcDir, { source_type: 'imported' }),
      ).rejects.toThrow(/disk full/)
    } finally {
      spy.mockRestore()
    }
    const skillsRoot = path.join(dataDir, 'skills')
    const remaining = await fs.readdir(skillsRoot).catch(() => [])
    // catch 块必须把 .tmp.* 清掉
    expect(remaining).toEqual([])
  })

  it('overwrite 路径 rename 失败时回滚 snapshot 到 targetDir', async () => {
    // 第一次正常安装
    const srcDir1 = path.join(tmpRoot, 'src-v1')
    await fs.mkdir(srcDir1, { recursive: true })
    await fs.writeFile(
      path.join(srcDir1, 'SKILL.md'),
      `---\nname: rollback-target\ndescription: d\nversion: 1.0.0\n---\nv1-body`,
    )
    const { entry: e1 } = await (manager as any).installSkillFromDirectory(
      srcDir1,
      { source_type: 'imported' },
    )
    const targetDir = path.join(dataDir, 'skills', e1.name)
    // 第二次覆盖时让最终 rename(tmpDir → targetDir) 失败
    const srcDir2 = path.join(tmpRoot, 'src-v2')
    await fs.mkdir(srcDir2, { recursive: true })
    await fs.writeFile(
      path.join(srcDir2, 'SKILL.md'),
      `---\nname: rollback-target\ndescription: d\nversion: 2.0.0\n---\nv2-body`,
    )

    // rename 会被调用 2 次：
    //   call 1: targetDir → .snapshots/<id>-<ts>（旧目录搬到 snapshot）
    //   call 2: tmpDir → targetDir（新目录就位） ← 让它 throw
    const origRename = fs.rename
    let renameCallCount = 0
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      renameCallCount += 1
      if (renameCallCount === 2) {
        throw new Error('rename target failed simulated')
      }
      return origRename(src, dst)
    })

    try {
      await expect(
        (manager as any).installSkillFromDirectory(srcDir2, { source_type: 'imported' }, true),
      ).rejects.toThrow(/rename target failed/)
    } finally {
      spy.mockRestore()
    }

    // 回滚验证：旧 targetDir 应该被恢复（v1-body 还在）
    const body = await fs.readFile(path.join(targetDir, 'SKILL.md'), 'utf-8')
    expect(body).toContain('v1-body')

    // .tmp.* 必须清干净
    const skillsRoot = path.join(dataDir, 'skills')
    const remaining = await fs.readdir(skillsRoot)
    expect(remaining.filter(n => n.startsWith('.tmp.'))).toEqual([])
  })
})

describe('importFromZip 完整保留 scripts/references/assets', () => {
  let tmpRoot: string
  let dataDir: string
  let manager: SkillManager

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-zip-'))
    dataDir = path.join(tmpRoot, 'data')
    await fs.mkdir(dataDir, { recursive: true })
    manager = new SkillManager(dataDir)
    await manager.initialize()
  })
  afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }) })

  function buildZipBase64(entries: Array<{ name: string; content: string }>): string {
    const zip = new AdmZip()
    for (const e of entries) zip.addFile(e.name, Buffer.from(e.content, 'utf-8'))
    return zip.toBuffer().toString('base64')
  }

  it('zip 含 scripts/foo.py 上传后 scripts/foo.py 落到 <data_dir>/skills/<name>/', async () => {
    const b64 = buildZipBase64([
      { name: 'SKILL.md', content: '---\nname: zip-skill\ndescription: d\nversion: 1.0.0\n---\nbody' },
      { name: 'scripts/foo.py', content: 'print(1)' },
      { name: 'references/api.md', content: '# api' },
    ])
    const { entry } = await manager.importFromZip(b64, 'test.zip')
    expect(entry.skill_dir).toBeDefined()
    const skillDir = entry.skill_dir!
    expect(await fs.readFile(path.join(skillDir, 'scripts', 'foo.py'), 'utf-8')).toBe('print(1)')
    expect(await fs.readFile(path.join(skillDir, 'references', 'api.md'), 'utf-8')).toBe('# api')
  })

  it('zip 包了一层 wrapper 目录 my-skill/SKILL.md，能自动 strip', async () => {
    const b64 = buildZipBase64([
      { name: 'my-skill/SKILL.md', content: '---\nname: wrapped\ndescription: d\nversion: 1.0.0\n---\nbody' },
      { name: 'my-skill/scripts/x.py', content: 'x' },
    ])
    const { entry } = await manager.importFromZip(b64, 'wrapped.zip')
    expect(entry.skill_dir).toBeDefined()
    const skillDir = entry.skill_dir!
    expect(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8')).toContain('body')
    expect(await fs.readFile(path.join(skillDir, 'scripts', 'x.py'), 'utf-8')).toBe('x')
  })

  it('拒绝 zip slip：entry 名含 ../', async () => {
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from('---\nname: slip\ndescription: d\nversion: 1.0.0\n---\nbody'))
    zip.addFile('evil.sh', Buffer.from('pwn'))
    // adm-zip 的 addFile 会调用 canonical() 把 ../ 去掉；只能 add 后再回填 entryName 才能造出带 ../ 的恶意 zip
    for (const e of zip.getEntries()) {
      if (e.entryName === 'evil.sh') e.entryName = '../evil.sh'
    }
    const b64 = zip.toBuffer().toString('base64')
    await expect(manager.importFromZip(b64, 'slip.zip')).rejects.toThrow(/path traversal|非法路径|invalid/i)
  })

  it('拒绝 zip slip：path.resolve 防御兜底（第二道防线）', async () => {
    // 在 POSIX 上 path.join(absRoot, anything) 总会规范化到 absRoot 下，
    // 第一道防御 (entryName.includes('..')) 已经覆盖了所有真实攻击样本。
    // 这里通过 mock path.join 模拟一个"第一道漏过、第二道必须拦下"的场景，
    // 验证 path.resolve 防御逻辑确实生效（防御深度，防止未来重构破坏不变量）。
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from('---\nname: defend\ndescription: d\nversion: 1.0.0\n---\nbody'))
    zip.addFile('benign.txt', Buffer.from('pwn'))
    const b64 = zip.toBuffer().toString('base64')

    // 注意：entryName 不含 ..，第一道防御不会触发
    // 但我们让 path.join 在处理 benign.txt 时返回一个解析后越界的路径
    const origJoin = path.join.bind(path)
    const spy = vi.spyOn(path, 'join').mockImplementation((...args: string[]) => {
      const result = origJoin(...args)
      // 只在拼接 benign.txt 这一次时改成越界路径，其他调用照常
      if (args[args.length - 1] === 'benign.txt') {
        return '/tmp/crabot-zipslip-evil-out-of-bounds'
      }
      return result
    })

    try {
      await expect(manager.importFromZip(b64, 'defend.zip')).rejects.toThrow(/path traversal|非法路径|invalid/i)
    } finally {
      spy.mockRestore()
    }
  })

  it('importFromZip 成功后 <skillsRoot> 不留 .extract.* 残留', async () => {
    const b64 = buildZipBase64([
      { name: 'SKILL.md', content: '---\nname: cleanup-test\ndescription: d\nversion: 1.0.0\n---\nbody' },
      { name: 'scripts/x.py', content: 'x' },
    ])
    await manager.importFromZip(b64, 'cleanup.zip')
    const skillsRoot = path.join(dataDir, 'skills')
    const remaining = await fs.readdir(skillsRoot)
    expect(remaining.filter(n => n.startsWith('.extract.'))).toEqual([])
  })
})

describe('importFromLocalPath 复制而非引用', () => {
  let tmpRoot: string
  let dataDir: string
  let manager: SkillManager
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-local-'))
    dataDir = path.join(tmpRoot, 'data')
    await fs.mkdir(dataDir, { recursive: true })
    manager = new SkillManager(dataDir)
    await manager.initialize()
  })
  afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }) })

  it('用户原目录被删除后 skill 仍可读', async () => {
    const userDir = path.join(tmpRoot, 'user-skill')
    await fs.mkdir(path.join(userDir, 'scripts'), { recursive: true })
    await fs.writeFile(path.join(userDir, 'SKILL.md'), '---\nname: local-skill\ndescription: d\nversion: 1.0.0\n---\nbody')
    await fs.writeFile(path.join(userDir, 'scripts', 'a.py'), 'a')

    const { entry } = await manager.importFromLocalPath(userDir)
    expect(entry.skill_dir).toBeDefined()
    const skillDir = entry.skill_dir!
    expect(skillDir).not.toBe(userDir)
    expect(skillDir.startsWith(path.join(dataDir, 'skills'))).toBe(true)

    // 删除用户原目录
    await fs.rm(userDir, { recursive: true })
    // skill 仍可读
    expect(await fs.readFile(path.join(skillDir, 'scripts', 'a.py'), 'utf-8')).toBe('a')
  })

  it('禁止访问系统敏感目录', async () => {
    await expect(manager.importFromLocalPath('/etc')).rejects.toThrow(/禁止访问/)
    await expect(manager.importFromLocalPath('/etc/foo')).rejects.toThrow(/禁止访问/)
  })
})

describe('importFromGit 拉完整 archive', () => {
  let tmpRoot: string
  let dataDir: string
  let manager: SkillManager

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-git-'))
    dataDir = path.join(tmpRoot, 'data')
    await fs.mkdir(dataDir, { recursive: true })
    manager = new SkillManager(dataDir)
    await manager.initialize()
  })
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('从 raw URL 反推 archive，下载后拿到完整目录', async () => {
    // 构造 GitHub archive zip（顶层目录约定为 <repo>-<branch>/）
    const zip = new AdmZip()
    zip.addFile('myrepo-main/skills/foo/SKILL.md', Buffer.from('---\nname: git-skill\ndescription: d\nversion: 1.0.0\n---\nbody'))
    zip.addFile('myrepo-main/skills/foo/scripts/foo.py', Buffer.from('git'))
    zip.addFile('myrepo-main/skills/foo/references/api.md', Buffer.from('# api'))
    // 仓库里其它无关文件（应该被 strip）
    zip.addFile('myrepo-main/README.md', Buffer.from('readme'))
    zip.addFile('myrepo-main/skills/bar/SKILL.md', Buffer.from('---\nname: bar\ndescription: d\nversion: 1.0.0\n---\n'))
    const zipBuf = zip.toBuffer()

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      statusText: 'OK',
      arrayBuffer: async () => zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength),
    } as Response)

    const skillMdUrl = 'https://raw.githubusercontent.com/me/myrepo/main/skills/foo/SKILL.md'
    const { entry } = await manager.importFromGit(skillMdUrl, 'https://github.com/me/myrepo')

    const skillDir = entry.skill_dir!
    expect(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8')).toContain('body')
    expect(await fs.readFile(path.join(skillDir, 'scripts', 'foo.py'), 'utf-8')).toBe('git')
    expect(await fs.readFile(path.join(skillDir, 'references', 'api.md'), 'utf-8')).toBe('# api')
    // 仓库外的文件不应进入 skill 目录
    expect(await fs.access(path.join(skillDir, '..', 'README.md')).then(() => true).catch(() => false)).toBe(false)
  })

  it('拒绝非 raw.githubusercontent.com URL', async () => {
    await expect(manager.importFromGit('https://example.com/foo/SKILL.md')).rejects.toThrow(/raw\.githubusercontent\.com/)
  })

  it('URL 格式不符（不以 SKILL.md 结尾）拒绝', async () => {
    await expect(manager.importFromGit('https://raw.githubusercontent.com/me/repo/main/skills/foo/README.md')).rejects.toThrow(/URL 格式不符/)
  })

  it('archive 中目标子目录的 SKILL.md 不存在 → 报错', async () => {
    const zip = new AdmZip()
    // archive 内根本没有 skills/foo/SKILL.md
    zip.addFile('myrepo-main/README.md', Buffer.from('readme'))
    const zipBuf = zip.toBuffer()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      statusText: 'OK',
      arrayBuffer: async () => zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength),
    } as Response)
    await expect(manager.importFromGit('https://raw.githubusercontent.com/me/myrepo/main/skills/foo/SKILL.md'))
      .rejects.toThrow(/SKILL\.md 不存在/)
  })
})

describe('toRestEntry 即时附加 content 字段', () => {
  let tmpRoot: string, dataDir: string, manager: SkillManager
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rest-entry-'))
    dataDir = path.join(tmpRoot, 'data')
    await fs.mkdir(dataDir, { recursive: true })
    manager = new SkillManager(dataDir)
    await manager.initialize()
  })
  afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }) })

  it('toRestEntry 返回 entry + 即时读到的 SKILL.md content', async () => {
    const src = path.join(tmpRoot, 'src')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'SKILL.md'), '---\nname: rest-test\ndescription: d\nversion: 1.0.0\n---\nbody-text')
    const { entry } = await manager.importFromLocalPath(src)
    const rest = await manager.toRestEntry(entry)
    expect(rest.id).toBe(entry.id)
    expect(rest.name).toBe(entry.name)
    expect(rest.content).toContain('body-text')
    expect(rest.skill_dir).toBe(entry.skill_dir)
  })

  it('toRestEntries 批量也对', async () => {
    for (const n of ['a', 'b']) {
      const src = path.join(tmpRoot, `src-${n}`)
      await fs.mkdir(src, { recursive: true })
      await fs.writeFile(path.join(src, 'SKILL.md'), `---\nname: skill-${n}\ndescription: d\nversion: 1.0.0\n---\nbody-${n}`)
      await manager.importFromLocalPath(src)
    }
    const entries = manager.list()
    const rests = await manager.toRestEntries(entries)
    expect(rests.length).toBe(entries.length)
    expect(rests.find(r => r.name === 'skill-a')?.content).toContain('body-a')
    expect(rests.find(r => r.name === 'skill-b')?.content).toContain('body-b')
  })

  it('SKILL.md 丢失时 content 是空串而非崩', async () => {
    const src = path.join(tmpRoot, 'src')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'SKILL.md'), '---\nname: gone\ndescription: d\nversion: 1.0.0\n---\nbody')
    const { entry } = await manager.importFromLocalPath(src)
    await fs.rm(path.join(entry.skill_dir, 'SKILL.md'))
    const rest = await manager.toRestEntry(entry)
    expect(rest.content).toBe('')
  })
})

describe('migrateLegacyEntries 自动迁移', () => {
  let tmpRoot: string, dataDir: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-'))
    dataDir = path.join(tmpRoot, 'data')
    await fs.mkdir(dataDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('legacy entry（含 content 字段、无 skill_dir 新目录）启动后被迁移到新布局', async () => {
    const legacyEntries = [{
      id: 'legacy-1',
      name: 'legacy-skill',
      description: 'd',
      version: '1.0.0',
      content: '---\nname: legacy-skill\ndescription: d\nversion: 1.0.0\n---\nold body',
      source_type: 'imported',
      is_builtin: false,
      is_essential: false,
      can_disable: true,
      enabled: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }]
    await fs.writeFile(path.join(dataDir, 'skills.json'), JSON.stringify(legacyEntries))

    const manager = new SkillManager(dataDir)
    await manager.initialize()

    const e = manager.get('legacy-1')!
    expect(e.skill_dir).toBe(path.join(dataDir, 'skills', 'legacy-skill'))
    expect(await fs.readFile(path.join(e.skill_dir, 'SKILL.md'), 'utf-8')).toContain('old body')
    expect('content' in e).toBe(false)
    // 备份文件存在
    const backups = (await fs.readdir(dataDir)).filter(n => n.startsWith('skills.json.bak-'))
    expect(backups.length).toBeGreaterThan(0)
  })

  it('legacy importFromLocalPath 模式（skill_dir 指向用户原目录）→ 复制到新布局', async () => {
    const userDir = path.join(tmpRoot, 'user-src')
    await fs.mkdir(path.join(userDir, 'scripts'), { recursive: true })
    await fs.writeFile(path.join(userDir, 'SKILL.md'), '---\nname: legacy-local\ndescription: d\nversion: 1.0.0\n---\nbody')
    await fs.writeFile(path.join(userDir, 'scripts', 'a.py'), 'a')

    const legacyEntries = [{
      id: 'legacy-2',
      name: 'legacy-local',
      description: 'd',
      version: '1.0.0',
      content: '---\nname: legacy-local\ndescription: d\nversion: 1.0.0\n---\nbody',
      skill_dir: userDir,
      source_type: 'imported',
      is_builtin: false,
      is_essential: false,
      can_disable: true,
      enabled: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }]
    await fs.writeFile(path.join(dataDir, 'skills.json'), JSON.stringify(legacyEntries))

    const manager = new SkillManager(dataDir)
    await manager.initialize()

    const e = manager.get('legacy-2')!
    expect(e.skill_dir).toBe(path.join(dataDir, 'skills', 'legacy-local'))
    expect(await fs.readFile(path.join(e.skill_dir, 'scripts', 'a.py'), 'utf-8')).toBe('a')
    expect(await fs.readFile(path.join(e.skill_dir, 'SKILL.md'), 'utf-8')).toContain('body')
  })

  it('legacy previous_snapshot 嵌入式（content + files）→ 迁移到 .snapshots/<id>-<ts>/', async () => {
    const legacyEntries = [{
      id: 'legacy-3',
      name: 'snapped-skill',
      description: 'd',
      version: '2.0.0',
      content: '---\nname: snapped-skill\ndescription: d\nversion: 2.0.0\n---\nnew body',
      source_type: 'imported',
      is_builtin: false,
      is_essential: false,
      can_disable: true,
      enabled: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      previous_snapshot: {
        content: '---\nname: snapped-skill\ndescription: d\nversion: 1.0.0\n---\nold body',
        version: '1.0.0',
        files: { 'scripts/old.py': 'old' },
        updated_at: '2026-01-01T00:00:00.000Z',
        snapshotted_at: '2026-01-01T00:00:00.000Z',
      },
    }]
    await fs.writeFile(path.join(dataDir, 'skills.json'), JSON.stringify(legacyEntries))

    const manager = new SkillManager(dataDir)
    await manager.initialize()

    const e = manager.get('legacy-3')!
    expect(e.previous_snapshot?.snapshot_dir).toMatch(/^\.snapshots\//)
    const snapAbs = path.join(dataDir, 'skills', e.previous_snapshot!.snapshot_dir)
    expect(await fs.readFile(path.join(snapAbs, 'SKILL.md'), 'utf-8')).toContain('old body')
    expect(await fs.readFile(path.join(snapAbs, 'scripts', 'old.py'), 'utf-8')).toBe('old')
    expect((e.previous_snapshot as any).content).toBeUndefined()
    expect((e.previous_snapshot as any).files).toBeUndefined()
  })

  it('已新格式 entry 不重复迁移（幂等）', async () => {
    // 提前手动建好新格式的 entry + 磁盘（dir 用 name，basename === entry.name）
    const skillDir = path.join(dataDir, 'skills', 'modern')
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: modern\ndescription: d\nversion: 1.0.0\n---\nbody')
    const modernEntries = [{
      id: 'modern-1',
      name: 'modern',
      description: 'd',
      version: '1.0.0',
      skill_dir: skillDir,
      source_type: 'imported',
      is_builtin: false,
      is_essential: false,
      can_disable: true,
      enabled: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }]
    await fs.writeFile(path.join(dataDir, 'skills.json'), JSON.stringify(modernEntries))

    const manager = new SkillManager(dataDir)
    await manager.initialize()
    // 不应触发备份
    const backups = (await fs.readdir(dataDir)).filter(n => n.startsWith('skills.json.bak-'))
    expect(backups.length).toBe(0)
  })

  it('builtin entry 不迁移（content 留在原地，registerBuiltins 会同步）', async () => {
    const legacyEntries = [{
      id: 'builtin-1',
      name: 'builtin-skill',
      description: 'd',
      version: '1.0.0',
      content: '---\nname: builtin-skill\ndescription: d\nversion: 1.0.0\n---\nbody',
      skill_dir: '/some/builtin/dir',
      source_type: 'builtin',
      is_builtin: true,
      is_essential: false,
      can_disable: true,
      enabled: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }]
    await fs.writeFile(path.join(dataDir, 'skills.json'), JSON.stringify(legacyEntries))

    const manager = new SkillManager(dataDir)
    await manager.initialize()
    const e = manager.get('builtin-1')!
    // builtin 跳过迁移：skill_dir 保留原值
    expect(e.skill_dir).toBe('/some/builtin/dir')
    // content 仍删除（接口清理）
    expect('content' in e).toBe(false)
  })
})

describe('skill 目录用 name 不用 UUID（Anthropic 标准）', () => {
  let tmpRoot: string, dataDir: string, manager: SkillManager
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'name-dir-'))
    dataDir = path.join(tmpRoot, 'data')
    await fs.mkdir(dataDir, { recursive: true })
    manager = new SkillManager(dataDir)
    await manager.initialize()
  })
  afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }) })

  it('importFromLocalPath 后 skill_dir 用 name 而不是 UUID', async () => {
    const src = path.join(tmpRoot, 'src')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'SKILL.md'), '---\nname: my-cool-skill\ndescription: d\nversion: 1.0.0\n---\nbody')
    const { entry } = await manager.importFromLocalPath(src)
    expect(entry.skill_dir).toBe(path.join(dataDir, 'skills', 'my-cool-skill'))
    expect(path.basename(entry.skill_dir)).toBe('my-cool-skill')
    // entry.id 仍是 UUID（registry 主键）
    expect(entry.id).toMatch(/^[0-9a-f]{8}-/)
  })

  it('importFromZip 后 skill_dir 用 name', async () => {
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from('---\nname: zip-named\ndescription: d\nversion: 1.0.0\n---\nbody'))
    const { entry } = await manager.importFromZip(zip.toBuffer().toString('base64'), 'test.zip')
    expect(path.basename(entry.skill_dir)).toBe('zip-named')
  })

  it('update content 后 snapshot 用 name 不用 id', async () => {
    const src = path.join(tmpRoot, 'src')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'SKILL.md'), '---\nname: snap-named\ndescription: d\nversion: 1.0.0\n---\nold')
    const { entry } = await manager.importFromLocalPath(src)
    await manager.update(entry.id, { content: '---\nname: snap-named\ndescription: d\nversion: 2.0.0\n---\nnew' })
    const after = manager.get(entry.id)!
    expect(after.previous_snapshot!.snapshot_dir).toMatch(/^\.snapshots\/snap-named-/)
  })

  it('update name 时 mv 目录', async () => {
    const src = path.join(tmpRoot, 'src')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'SKILL.md'), '---\nname: old-name\ndescription: d\nversion: 1.0.0\n---\nbody')
    const { entry } = await manager.importFromLocalPath(src)
    const oldDir = entry.skill_dir
    await manager.update(entry.id, { name: 'new-name' })
    const after = manager.get(entry.id)!
    expect(path.basename(after.skill_dir)).toBe('new-name')
    expect(await fs.access(oldDir).then(() => true).catch(() => false)).toBe(false)
    expect(await fs.access(after.skill_dir).then(() => true).catch(() => false)).toBe(true)
  })

  it('orphan 目录冲突 → 拒绝导入', async () => {
    // 手动建一个孤儿目录
    await fs.mkdir(path.join(dataDir, 'skills', 'orphan-skill'), { recursive: true })
    const src = path.join(tmpRoot, 'src')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'SKILL.md'), '---\nname: orphan-skill\ndescription: d\nversion: 1.0.0\n---\nbody')
    await expect(manager.importFromLocalPath(src)).rejects.toThrow(/孤儿|orphan/i)
  })

  it('非法 name（含 ../）拒绝导入', async () => {
    const src = path.join(tmpRoot, 'src')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'SKILL.md'), '---\nname: ../evil\ndescription: d\nversion: 1.0.0\n---\nbody')
    await expect(manager.importFromLocalPath(src)).rejects.toThrow(/非法字符|invalid/i)
  })

  it('migrate: legacy UUID 目录自动 mv 到 name 目录', async () => {
    // 手工建一个"已用新格式但目录是 UUID 命名"的 entry
    const uuidDir = path.join(dataDir, 'skills', 'old-uuid-id-12345')
    await fs.mkdir(uuidDir, { recursive: true })
    await fs.writeFile(path.join(uuidDir, 'SKILL.md'), '---\nname: legacy-named\ndescription: d\nversion: 1.0.0\n---\nbody')
    await fs.mkdir(path.join(uuidDir, 'scripts'), { recursive: true })
    await fs.writeFile(path.join(uuidDir, 'scripts', 'foo.py'), 'foo')

    const entries = [{
      id: 'old-uuid-id-12345',
      name: 'legacy-named',
      description: 'd',
      version: '1.0.0',
      skill_dir: uuidDir,
      source_type: 'imported' as const,
      is_builtin: false,
      is_essential: false,
      can_disable: true,
      enabled: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }]
    await fs.writeFile(path.join(dataDir, 'skills.json'), JSON.stringify(entries))

    const m2 = new SkillManager(dataDir)
    await m2.initialize()
    const e = m2.get('old-uuid-id-12345')!
    expect(e.skill_dir).toBe(path.join(dataDir, 'skills', 'legacy-named'))
    expect(await fs.readFile(path.join(e.skill_dir, 'SKILL.md'), 'utf-8')).toContain('body')
    expect(await fs.readFile(path.join(e.skill_dir, 'scripts', 'foo.py'), 'utf-8')).toBe('foo')
    // 旧 UUID 目录应不存在
    expect(await fs.access(uuidDir).then(() => true).catch(() => false)).toBe(false)
  })
})

describe('SkillManager.registerBuiltins', () => {
  let tmpRoot: string
  let dataDir: string
  let builtinsDir: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'builtin-skill-prune-'))
    dataDir = path.join(tmpRoot, 'data')
    builtinsDir = path.join(tmpRoot, 'builtins')
    await fs.mkdir(dataDir, { recursive: true })
    await fs.mkdir(path.join(builtinsDir, 'active-skill'), { recursive: true })
    await fs.writeFile(
      path.join(builtinsDir, 'active-skill', 'SKILL.md'),
      '---\nname: active-skill\ndescription: active\nversion: 1.0.0\n---\nbody',
    )
  })

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('upgrades remove obsolete builtin entries from the scanned directory only', async () => {
    const entry = (id: string, name: string, skillDir: string) => ({
      id,
      name,
      description: name,
      version: '1.0.0',
      skill_dir: skillDir,
      source_type: 'builtin' as const,
      is_builtin: true,
      is_essential: false,
      can_disable: true,
      enabled: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    await fs.writeFile(path.join(dataDir, 'skills.json'), JSON.stringify([
      entry('obsolete-daily', 'daily-reflection', path.join(builtinsDir, 'daily-reflection')),
      entry('obsolete-curate', 'memory-curate', path.join(builtinsDir, 'memory-curate')),
      entry('retained-seed', 'writing-plans', path.join(tmpRoot, 'builtin-skills', 'writing-plans')),
    ]))

    const manager = new SkillManager(dataDir)
    await manager.initialize()
    await manager.registerBuiltins(builtinsDir)

    expect(manager.findByName('daily-reflection')).toBeUndefined()
    expect(manager.findByName('memory-curate')).toBeUndefined()
    expect(manager.findByName('active-skill')?.is_builtin).toBe(true)
    expect(manager.get('retained-seed')?.name).toBe('writing-plans')

    const restarted = new SkillManager(dataDir)
    await restarted.initialize()
    expect(restarted.findByName('daily-reflection')).toBeUndefined()
    expect(restarted.findByName('memory-curate')).toBeUndefined()
  })
})

describe('MCPServerManager.upsertById', () => {
  let tmpData: string
  let manager: MCPServerManager

  const makeEntry = (id: string, name: string): MCPServerRegistryEntry => ({
    id,
    name,
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    is_builtin: false,
    is_essential: false,
    can_disable: true,
    enabled: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  })

  beforeEach(async () => {
    tmpData = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-upsert-'))
    manager = new MCPServerManager(tmpData)
    await manager.initialize()
  })

  afterEach(async () => {
    await fs.rm(tmpData, { recursive: true, force: true })
  })

  it('新 id → 返回 imported，list 中可查到', async () => {
    const result = await manager.upsertById(makeEntry('mcp-import-1', 'my-server'), 'skip')
    expect(result).toBe('imported')
    expect(manager.get('mcp-import-1')?.name).toBe('my-server')
  })

  it('同 id + skip → 返回 skipped，值不变', async () => {
    await manager.upsertById(makeEntry('mcp-import-2', 'Original'), 'skip')
    const result = await manager.upsertById(makeEntry('mcp-import-2', 'Updated'), 'skip')
    expect(result).toBe('skipped')
    expect(manager.get('mcp-import-2')?.name).toBe('Original')
  })

  it('同 id + overwrite → 返回 overwritten，值更新', async () => {
    await manager.upsertById(makeEntry('mcp-import-3', 'Original'), 'skip')
    const result = await manager.upsertById(makeEntry('mcp-import-3', 'Updated'), 'overwrite')
    expect(result).toBe('overwritten')
    expect(manager.get('mcp-import-3')?.name).toBe('Updated')
  })
})
