import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { captureWorkspaceInstructions } from '../../../src/workers/harness/workspace-instructions.js'

let root: string
let workspace: string
let workersDir: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'workspace-instructions-test-'))
  workspace = join(root, 'workspace')
  workersDir = join(root, 'workers')
  await fs.mkdir(workspace)
})

afterEach(async () => {
  await fs.chmod(workspace, 0o700).catch(() => undefined)
  await fs.rm(root, { recursive: true, force: true })
})

function capture(incarnationId = 'inc-1'): ReturnType<typeof captureWorkspaceInstructions> {
  return captureWorkspaceInstructions({
    workersDir,
    workerId: 'w-1',
    incarnationId,
    workspaceRoot: workspace,
    capturedAt: '2026-08-20T00:00:00.000Z',
  })
}

async function expectSnapshot(contents: string, incarnationId = 'inc-1'): Promise<void> {
  const captured = await capture(incarnationId)
  expect(captured.snapshot).toEqual({
    source: 'agents_md',
    captured_at: '2026-08-20T00:00:00.000Z',
    digest: createHash('sha256').update(contents).digest('hex'),
    artifact_id: `workspace-instructions/w-1/${incarnationId}`,
  })
  expect(captured.text).toBe(contents)
  expect(await fs.readFile(join(workersDir, 'w-1', 'workspace-instructions', `${incarnationId}.md`), 'utf-8')).toBe(contents)
}

async function writeLegacyRecord(kind: 'hardlink' | 'snapshot_copy', contents?: string): Promise<void> {
  const instructionsDir = join(workersDir, 'w-old', 'workspace-instructions')
  await fs.mkdir(instructionsDir, { recursive: true })
  if (contents !== undefined) await fs.writeFile(join(instructionsDir, 'inc-old.md'), contents)
  await fs.writeFile(join(instructionsDir, 'inc-old.claude-bridge.json'), JSON.stringify({
    workspace_root: workspace,
    claude_path: join(workspace, 'CLAUDE.md'),
    kind,
  }))
}

describe('captureWorkspaceInstructions', () => {
  it('只有 AGENTS.md 时创建并长期保留 CLAUDE.md 相对软链接，再抓取不可变快照', async () => {
    const contents = '# Local rules\nDo not touch production.\n'
    await fs.writeFile(join(workspace, 'AGENTS.md'), contents)

    await expectSnapshot(contents)

    expect(await fs.readlink(join(workspace, 'CLAUDE.md'))).toBe('AGENTS.md')
    expect(await fs.readFile(join(workspace, 'CLAUDE.md'), 'utf-8')).toBe(contents)
  })

  it('只有 CLAUDE.md 时创建并长期保留 AGENTS.md 相对软链接，再从统一入口抓快照', async () => {
    const contents = '# Claude rules\nUse the project protocol.\n'
    await fs.writeFile(join(workspace, 'CLAUDE.md'), contents)

    await expectSnapshot(contents)

    expect(await fs.readlink(join(workspace, 'AGENTS.md'))).toBe('CLAUDE.md')
    expect(await fs.readFile(join(workspace, 'AGENTS.md'), 'utf-8')).toBe(contents)
  })

  it('已有任一方向的有效软链接时保持原方向', async () => {
    await fs.writeFile(join(workspace, 'AGENTS.md'), '# A\n')
    await fs.symlink('AGENTS.md', join(workspace, 'CLAUDE.md'))
    await expectSnapshot('# A\n', 'inc-a')
    expect(await fs.readlink(join(workspace, 'CLAUDE.md'))).toBe('AGENTS.md')

    await fs.rm(join(workspace, 'CLAUDE.md'))
    await fs.rename(join(workspace, 'AGENTS.md'), join(workspace, 'CLAUDE.md'))
    await fs.symlink('CLAUDE.md', join(workspace, 'AGENTS.md'))
    await expectSnapshot('# A\n', 'inc-b')
    expect(await fs.readlink(join(workspace, 'AGENTS.md'))).toBe('CLAUDE.md')
  })

  it('双缺失是明确可运行状态，不创建空入口或 artifact', async () => {
    const captured = await capture()

    expect(captured).toEqual({ snapshot: { source: 'absent', captured_at: '2026-08-20T00:00:00.000Z' } })
    await expect(fs.access(join(workspace, 'AGENTS.md'))).rejects.toThrow()
    await expect(fs.access(join(workspace, 'CLAUDE.md'))).rejects.toThrow()
    await expect(fs.access(join(workersDir, 'w-1', 'workspace-instructions', 'inc-1.md'))).rejects.toThrow()
  })

  it('两份独立正文即使内容相同也拒绝，不覆盖或删除任何一侧', async () => {
    await fs.writeFile(join(workspace, 'AGENTS.md'), 'same\n')
    await fs.writeFile(join(workspace, 'CLAUDE.md'), 'same\n')

    await expect(capture()).rejects.toThrow(/两份独立正文/)

    expect(await fs.readFile(join(workspace, 'AGENTS.md'), 'utf-8')).toBe('same\n')
    expect(await fs.readFile(join(workspace, 'CLAUDE.md'), 'utf-8')).toBe('same\n')
  })

  it('可由旧私有记录和 inode 证明的 hardlink 一次性迁移为长期软链接', async () => {
    await fs.writeFile(join(workspace, 'AGENTS.md'), 'hardlink rules\n')
    await fs.link(join(workspace, 'AGENTS.md'), join(workspace, 'CLAUDE.md'))
    await writeLegacyRecord('hardlink')

    await expectSnapshot('hardlink rules\n')

    expect(await fs.readlink(join(workspace, 'CLAUDE.md'))).toBe('AGENTS.md')
  })

  it('可由旧私有记录和不可变 artifact 证明的 snapshot copy 一次性迁移为长期软链接', async () => {
    await fs.writeFile(join(workspace, 'AGENTS.md'), 'current rules\n')
    await fs.writeFile(join(workspace, 'CLAUDE.md'), 'old captured rules\n')
    await writeLegacyRecord('snapshot_copy', 'old captured rules\n')

    await expectSnapshot('current rules\n')

    expect(await fs.readlink(join(workspace, 'CLAUDE.md'))).toBe('AGENTS.md')
    expect(await fs.readFile(join(workspace, 'CLAUDE.md'), 'utf-8')).toBe('current rules\n')
  })

  it('旧 snapshot copy 已被人修改时不能再用私有记录证明所有权', async () => {
    await fs.writeFile(join(workspace, 'AGENTS.md'), 'agents rules\n')
    await fs.writeFile(join(workspace, 'CLAUDE.md'), 'human changed rules\n')
    await writeLegacyRecord('snapshot_copy', 'old captured rules\n')

    await expect(capture()).rejects.toThrow(/两份独立正文/)
    expect(await fs.readFile(join(workspace, 'CLAUDE.md'), 'utf-8')).toBe('human changed rules\n')
  })

  it('悬空、循环、越界或指向非普通文件的软链接均 fail-loud', async () => {
    const outside = join(root, 'outside.md')
    await fs.writeFile(outside, '# outside\n')
    const cases: Array<() => Promise<void>> = [
      async () => { await fs.symlink('missing.md', join(workspace, 'AGENTS.md')) },
      async () => {
        await fs.symlink('CLAUDE.md', join(workspace, 'AGENTS.md'))
        await fs.symlink('AGENTS.md', join(workspace, 'CLAUDE.md'))
      },
      async () => { await fs.symlink('../outside.md', join(workspace, 'AGENTS.md')) },
      async () => {
        await fs.mkdir(join(workspace, 'rules'))
        await fs.symlink('rules', join(workspace, 'AGENTS.md'))
      },
    ]

    for (const setup of cases) {
      await fs.rm(join(workspace, 'AGENTS.md'), { force: true })
      await fs.rm(join(workspace, 'CLAUDE.md'), { force: true })
      await fs.rm(join(workspace, 'rules'), { recursive: true, force: true })
      await setup()
      await expect(capture()).rejects.toThrow(/软链接|普通文件/)
    }
  })

  it('软链接无法创建时不降级为 hardlink 或副本', async () => {
    await fs.writeFile(join(workspace, 'AGENTS.md'), 'rules\n')
    await fs.chmod(workspace, 0o500)

    await expect(capture()).rejects.toThrow(/无法创建长期相对软链接/)

    await fs.chmod(workspace, 0o700)
    await expect(fs.access(join(workspace, 'CLAUDE.md'))).rejects.toThrow()
  })
})
