import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { SkillManager, readSkillDirFiles, writeSkillDirFiles } from './mcp-skill-manager'

async function makeTmpDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

describe('readSkillDirFiles', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await makeTmpDir('crabot-readskill-')
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('空目录返回 {}', async () => {
    const result = await readSkillDirFiles(tmpDir)
    expect(result).toEqual({})
  })

  it('SKILL.md 不会被读', async () => {
    await fs.writeFile(path.join(tmpDir, 'SKILL.md'), 'content', 'utf-8')
    const result = await readSkillDirFiles(tmpDir)
    expect(result).toEqual({})
  })

  it('.skill_dir / .DS_Store / 隐藏文件不会被读', async () => {
    await fs.writeFile(path.join(tmpDir, '.skill_dir'), '/some/path', 'utf-8')
    await fs.writeFile(path.join(tmpDir, '.DS_Store'), 'macos', 'utf-8')
    await fs.writeFile(path.join(tmpDir, '.hidden'), 'h', 'utf-8')
    const result = await readSkillDirFiles(tmpDir)
    expect(result).toEqual({})
  })

  it('文本文件按相对路径作 key 直存', async () => {
    await fs.writeFile(path.join(tmpDir, 'foo.md'), 'foo content', 'utf-8')
    await fs.mkdir(path.join(tmpDir, 'references'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'references', 'arch.md'), 'arch', 'utf-8')
    const result = await readSkillDirFiles(tmpDir)
    expect(result).toEqual({
      'foo.md': 'foo content',
      'references/arch.md': 'arch',
    })
  })

  it('二进制文件用 base64: 前缀编码', async () => {
    const binBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    await fs.writeFile(path.join(tmpDir, 'img.png'), binBytes)
    const result = await readSkillDirFiles(tmpDir)
    expect(result!['img.png']).toBe(`base64:${binBytes.toString('base64')}`)
  })

  it('单文件 > 1MB 跳过且记录 warning', async () => {
    const bigBuf = Buffer.alloc(1024 * 1024 + 1, 'a')
    await fs.writeFile(path.join(tmpDir, 'big.txt'), bigBuf)
    await fs.writeFile(path.join(tmpDir, 'small.txt'), 'ok', 'utf-8')
    const result = await readSkillDirFiles(tmpDir)
    expect('big.txt' in (result ?? {})).toBe(false)
    expect((result ?? {})['small.txt']).toBe('ok')
  })

  it('总大小 > 5MB 返回 undefined', async () => {
    // 6 个 ~900KB 文件 → 累计超 5MB
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(path.join(tmpDir, `f${i}.txt`), Buffer.alloc(900 * 1024, 'a'))
    }
    const result = await readSkillDirFiles(tmpDir)
    expect(result).toBeUndefined()
  })

  it('源目录不存在时抛 ENOENT（调用方决定怎么处理）', async () => {
    await expect(readSkillDirFiles(path.join(tmpDir, 'nonexistent'))).rejects.toThrow()
  })
})

describe('SkillManager.update — snapshot 行为', () => {
  let tmpData: string
  let manager: SkillManager
  let skillSrcDir: string

  beforeEach(async () => {
    tmpData = await makeTmpDir('crabot-data-')
    manager = new SkillManager(tmpData)
    await manager.initialize()
    skillSrcDir = await makeTmpDir('crabot-skill-src-')
    await fs.writeFile(
      path.join(skillSrcDir, 'SKILL.md'),
      '---\nname: test-skill\ndescription: t\nversion: 1.0.0\n---\nv1 content',
      'utf-8',
    )
  })
  afterEach(async () => {
    await fs.rm(tmpData, { recursive: true, force: true })
    await fs.rm(skillSrcDir, { recursive: true, force: true })
  })

  it('仅 enabled toggle（content 不变）→ previous_snapshot 保留原值', async () => {
    const { entry: created } = await manager.importFromLocalPath(skillSrcDir)
    // 先做一次 content update 制造 previous_snapshot
    const afterFirstUpdate = await manager.update(created.id, { content: 'v2', version: '1.1.0' })
    const firstSnapshotted = afterFirstUpdate.previous_snapshot!.snapshotted_at

    // 再 toggle enabled，previous_snapshot 不应被覆盖
    const afterToggle = await manager.update(created.id, { enabled: false })
    expect(afterToggle.previous_snapshot).toBeDefined()
    expect(afterToggle.previous_snapshot!.snapshotted_at).toBe(firstSnapshotted)
  })

  it('连续两次 content update → 旧 snapshot_dir 被覆盖，N=1', async () => {
    const { entry: created } = await manager.importFromLocalPath(skillSrcDir)
    const afterFirst = await manager.update(created.id, { content: 'v2', version: '1.1.0' })
    const firstSnapDir = afterFirst.previous_snapshot!.snapshot_dir
    expect(firstSnapDir).toMatch(/^\.snapshots\//)

    const afterSecond = await manager.update(created.id, { content: 'v3', version: '1.2.0' })
    expect(afterSecond.previous_snapshot!.version).toBe('1.1.0')

    // 第一次的 snapshot_dir 已被删除
    await expect(fs.access(path.join(tmpData, 'skills', firstSnapDir))).rejects.toThrow()
    // 第二次的 snapshot_dir 存在并含 v2 SKILL.md
    const secondSnapAbs = path.join(tmpData, 'skills', afterSecond.previous_snapshot!.snapshot_dir)
    expect(await fs.readFile(path.join(secondSnapAbs, 'SKILL.md'), 'utf-8')).toBe('v2')
  })
})

describe('writeSkillDirFiles', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await makeTmpDir('crabot-writeskill-')
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('写 SKILL.md content', async () => {
    await writeSkillDirFiles(tmpDir, 'hello', {})
    const got = await fs.readFile(path.join(tmpDir, 'SKILL.md'), 'utf-8')
    expect(got).toBe('hello')
  })

  it('写多个文本附属文件', async () => {
    await writeSkillDirFiles(tmpDir, 'main', {
      'helper.md': 'h',
      'references/arch.md': 'arch',
    })
    expect(await fs.readFile(path.join(tmpDir, 'SKILL.md'), 'utf-8')).toBe('main')
    expect(await fs.readFile(path.join(tmpDir, 'helper.md'), 'utf-8')).toBe('h')
    expect(await fs.readFile(path.join(tmpDir, 'references', 'arch.md'), 'utf-8')).toBe('arch')
  })

  it('base64: 前缀文件解码回二进制', async () => {
    const binBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    await writeSkillDirFiles(tmpDir, 'main', {
      'img.png': `base64:${binBytes.toString('base64')}`,
    })
    const got = await fs.readFile(path.join(tmpDir, 'img.png'))
    expect(Buffer.compare(got, binBytes)).toBe(0)
  })

  it('清理 files 之外的文件（restore 时新增的要删）', async () => {
    await fs.writeFile(path.join(tmpDir, 'SKILL.md'), 'old', 'utf-8')
    await fs.writeFile(path.join(tmpDir, 'extra.md'), 'extra', 'utf-8')
    await writeSkillDirFiles(tmpDir, 'new', { 'helper.md': 'h' })
    expect(await fs.readFile(path.join(tmpDir, 'SKILL.md'), 'utf-8')).toBe('new')
    expect(await fs.readFile(path.join(tmpDir, 'helper.md'), 'utf-8')).toBe('h')
    await expect(fs.access(path.join(tmpDir, 'extra.md'))).rejects.toThrow()
  })

  it('清理空子目录', async () => {
    await fs.mkdir(path.join(tmpDir, 'orphan'), { recursive: true })
    await writeSkillDirFiles(tmpDir, 'new', {})
    await expect(fs.access(path.join(tmpDir, 'orphan'))).rejects.toThrow()
  })

  it('.skill_dir 等 sentinel 文件不会被清理', async () => {
    await fs.writeFile(path.join(tmpDir, '.skill_dir'), '/some/path', 'utf-8')
    await fs.writeFile(path.join(tmpDir, '.DS_Store'), 'macos', 'utf-8')
    await writeSkillDirFiles(tmpDir, 'new', {})
    expect(await fs.readFile(path.join(tmpDir, '.skill_dir'), 'utf-8')).toBe('/some/path')
    expect(await fs.readFile(path.join(tmpDir, '.DS_Store'), 'utf-8')).toBe('macos')
  })

  it('files = undefined 时只写 SKILL.md，不动其它', async () => {
    await fs.writeFile(path.join(tmpDir, 'SKILL.md'), 'old', 'utf-8')
    await fs.writeFile(path.join(tmpDir, 'keep.md'), 'keep', 'utf-8')
    await writeSkillDirFiles(tmpDir, 'new', undefined)
    expect(await fs.readFile(path.join(tmpDir, 'SKILL.md'), 'utf-8')).toBe('new')
    expect(await fs.readFile(path.join(tmpDir, 'keep.md'), 'utf-8')).toBe('keep')
  })

  it('嵌套路径自动 mkdir -p', async () => {
    await writeSkillDirFiles(tmpDir, 'main', {
      'a/b/c/deep.md': 'deep',
    })
    expect(await fs.readFile(path.join(tmpDir, 'a', 'b', 'c', 'deep.md'), 'utf-8')).toBe('deep')
  })
})

describe('SkillManager.restore', () => {
  let tmpData: string
  let manager: SkillManager
  let skillSrcDir: string

  beforeEach(async () => {
    tmpData = await makeTmpDir('crabot-data-')
    manager = new SkillManager(tmpData)
    await manager.initialize()
    skillSrcDir = await makeTmpDir('crabot-skill-src-')
    await fs.writeFile(
      path.join(skillSrcDir, 'SKILL.md'),
      '---\nname: t\ndescription: t\nversion: 1.0.0\n---\nv1',
      'utf-8',
    )
  })
  afterEach(async () => {
    await fs.rm(tmpData, { recursive: true, force: true })
    await fs.rm(skillSrcDir, { recursive: true, force: true })
  })

  it('无 previous_snapshot → throw', async () => {
    const { entry: created } = await manager.importFromLocalPath(skillSrcDir)
    await expect(manager.restore(created.id)).rejects.toThrow(/没有上一版可恢复/)
  })

  it('is_builtin → throw', async () => {
    const builtin = await manager.create({
      name: 'fake-builtin', description: 't', version: '1.0.0', content: 'v1',
    })
    const map = (manager as unknown as { skills: Map<string, typeof builtin> }).skills
    map.set(builtin.id, { ...builtin, is_builtin: true, previous_snapshot: {
      snapshot_dir: '.snapshots/fake', version: '0.9.0', updated_at: 't', snapshotted_at: 't',
    }})
    await expect(manager.restore(builtin.id)).rejects.toThrow(/是内置的，不能 restore/)
  })

  it('restore keeps exactly the one referenced snapshot', async () => {
    const { entry: created } = await manager.importFromLocalPath(skillSrcDir)
    await manager.update(created.id, { content: 'v2', version: '1.1.0' })
    await manager.restore(created.id)
    const after = manager.get(created.id)!
    const snapshotRoot = path.join(tmpData, 'skills', '.snapshots')
    expect((await fs.readdir(snapshotRoot)).sort()).toEqual([path.basename(after.previous_snapshot!.snapshot_dir)])
  })

  it('连续两次 restore → 来回 swap', async () => {
    const { entry: created } = await manager.importFromLocalPath(skillSrcDir)
    await manager.update(created.id, { content: 'v2', version: '1.1.0' })
    await manager.restore(created.id)  // 第一次 restore，磁盘内容回 v1
    const second = await manager.restore(created.id)  // 第二次 restore，磁盘内容回 v2
    const onDisk = await fs.readFile(path.join(second.skill_dir, 'SKILL.md'), 'utf-8')
    expect(onDisk).toBe('v2')
  })
})

describe('update + restore 文件夹 swap 语义（Task 6）', () => {
  let tmpRoot: string, dataDir: string, manager: SkillManager
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-swap-'))
    dataDir = path.join(tmpRoot, 'data')
    await fs.mkdir(dataDir, { recursive: true })
    manager = new SkillManager(dataDir)
    await manager.initialize()
  })
  afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }) })

  async function importSimple(name: string, body: string) {
    const src = path.join(tmpRoot, `src-${name}`)
    await fs.mkdir(path.join(src, 'scripts'), { recursive: true })
    await fs.writeFile(path.join(src, 'SKILL.md'), `---\nname: ${name}\ndescription: d\nversion: 1.0.0\n---\n${body}`)
    await fs.writeFile(path.join(src, 'scripts', 'a.py'), 'v1')
    return (await manager.importFromLocalPath(src)).entry
  }

  it('update content → .snapshots/<id>-<ts>/SKILL.md 含旧内容；新目录含新内容', async () => {
    const e = await importSimple('swap-skill', 'old-body')
    await manager.update(e.id, { content: '---\nname: swap-skill\ndescription: d\nversion: 2.0.0\n---\nnew-body' })
    const after = manager.get(e.id)!
    expect(after.previous_snapshot?.snapshot_dir).toMatch(/^\.snapshots\//)
    const snapAbs = path.join(dataDir, 'skills', after.previous_snapshot!.snapshot_dir!)
    expect(await fs.readFile(path.join(snapAbs, 'SKILL.md'), 'utf-8')).toContain('old-body')
    expect(await fs.readFile(path.join(snapAbs, 'scripts', 'a.py'), 'utf-8')).toBe('v1')
    expect(await fs.readFile(path.join(after.skill_dir!, 'SKILL.md'), 'utf-8')).toContain('new-body')
  })

  it('restore swap 把旧目录 mv 回当前位置；当前内容变成新 snapshot', async () => {
    const e = await importSimple('swap2', 'v1-body')
    await manager.update(e.id, { content: '---\nname: swap2\ndescription: d\nversion: 2.0.0\n---\nv2-body' })
    await manager.restore(e.id)
    const after = manager.get(e.id)!
    expect(await fs.readFile(path.join(after.skill_dir!, 'SKILL.md'), 'utf-8')).toContain('v1-body')
    expect(after.previous_snapshot).toBeDefined()
    const snapAbs = path.join(dataDir, 'skills', after.previous_snapshot!.snapshot_dir!)
    expect(await fs.readFile(path.join(snapAbs, 'SKILL.md'), 'utf-8')).toContain('v2-body')
  })

  it('update 不传 content → 不打 snapshot', async () => {
    const e = await importSimple('no-snap', 'body')
    await manager.update(e.id, { description: 'changed' })
    const after = manager.get(e.id)!
    expect(after.previous_snapshot).toBeUndefined()
    expect(after.description).toBe('changed')
  })

  it('update content 但内容相同 → 不打 snapshot', async () => {
    const e = await importSimple('same-content', 'body')
    const sameContent = '---\nname: same-content\ndescription: d\nversion: 1.0.0\n---\nbody'
    await manager.update(e.id, { content: sameContent })
    const after = manager.get(e.id)!
    expect(after.previous_snapshot).toBeUndefined()
  })

  it('builtin update 拒绝改 content', async () => {
    // 构造一个 builtin entry
    const builtinSrc = path.join(tmpRoot, 'builtin-src')
    await fs.mkdir(builtinSrc, { recursive: true })
    await fs.writeFile(path.join(builtinSrc, 'SKILL.md'), '---\nname: builtin-skill\ndescription: d\nversion: 1.0.0\n---\nbody')
    await manager.registerBuiltins(path.dirname(builtinSrc))  // 父目录扫
    const entries = manager.list().filter(s => s.is_builtin)
    expect(entries.length).toBeGreaterThan(0)  // 如果 registerBuiltins 没扫到，测试就 FAIL 而非静默通过
    const b = entries[0]
    await expect(manager.update(b.id, { content: 'new' })).rejects.toThrow(/内置/)
  })
})
