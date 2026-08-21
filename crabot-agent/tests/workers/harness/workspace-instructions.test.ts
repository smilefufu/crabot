import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  captureWorkspaceInstructions,
  cleanupClaudeWorkspaceBridge,
  prepareClaudeWorkspaceBridge,
} from '../../../src/workers/harness/workspace-instructions.js'

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
  await fs.rm(root, { recursive: true, force: true })
})

function capture(): ReturnType<typeof captureWorkspaceInstructions> {
  return captureWorkspaceInstructions({
    workersDir,
    workerId: 'w-1',
    incarnationId: 'inc-1',
    workspaceRoot: workspace,
    capturedAt: '2026-08-20T00:00:00.000Z',
  })
}

describe('captureWorkspaceInstructions', () => {
  it('只读取 AGENTS.md，并把不可变正文快照保存在 Harness 私有目录', async () => {
    const contents = '# Local rules\nDo not touch production.\n'
    await fs.writeFile(join(workspace, 'AGENTS.md'), contents)

    const captured = await capture()

    expect(captured.snapshot).toEqual({
      source: 'agents_md',
      captured_at: '2026-08-20T00:00:00.000Z',
      digest: createHash('sha256').update(contents).digest('hex'),
      artifact_id: 'workspace-instructions/w-1/inc-1',
    })
    expect(captured.text).toBe(contents)
    expect(await fs.readFile(join(workersDir, 'w-1', 'workspace-instructions', 'inc-1.md'), 'utf-8')).toBe(contents)
    expect(await fs.readFile(join(workspace, 'AGENTS.md'), 'utf-8')).toBe(contents)
  })

  it('AGENTS.md 不存在是明确的可运行状态，不创建空文件或 artifact', async () => {
    const captured = await capture()

    expect(captured).toEqual({ snapshot: { source: 'absent', captured_at: '2026-08-20T00:00:00.000Z' } })
    await expect(fs.access(join(workspace, 'AGENTS.md'))).rejects.toThrow()
    await expect(fs.access(join(workersDir, 'w-1', 'workspace-instructions', 'inc-1.md'))).rejects.toThrow()
  })
})

describe('prepareClaudeWorkspaceBridge', () => {
  it('仅在不存在用户 CLAUDE.md 时创建 Harness-owned bridge，并可按私有记录清理', async () => {
    await fs.writeFile(join(workspace, 'AGENTS.md'), 'follow this\n')
    const instructions = await capture()

    const bridge = await prepareClaudeWorkspaceBridge({
      workersDir,
      workerId: 'w-1',
      incarnationId: 'inc-1',
      workspaceRoot: workspace,
      instructions,
    })

    expect(bridge.managed).toBe(true)
    expect(await fs.readFile(join(workspace, 'CLAUDE.md'), 'utf-8')).toBe('follow this\n')
    expect(await fs.readFile(join(workspace, 'AGENTS.md'), 'utf-8')).toBe('follow this\n')

    await cleanupClaudeWorkspaceBridge({ workersDir, workerId: 'w-1', incarnationId: 'inc-1', workspaceRoot: workspace })
    await expect(fs.access(join(workspace, 'CLAUDE.md'))).rejects.toThrow()
    expect(await fs.readFile(join(workspace, 'AGENTS.md'), 'utf-8')).toBe('follow this\n')
  })

  it('已有 CLAUDE.md 时不覆盖，保留给 adapter 的只读 launch-context fallback', async () => {
    await fs.writeFile(join(workspace, 'AGENTS.md'), 'agents rules\n')
    await fs.writeFile(join(workspace, 'CLAUDE.md'), 'human rules\n')
    const instructions = await capture()

    await expect(prepareClaudeWorkspaceBridge({
      workersDir,
      workerId: 'w-1',
      incarnationId: 'inc-1',
      workspaceRoot: workspace,
      instructions,
    })).resolves.toEqual({ kind: 'user_owned_claude_md', managed: false })

    expect(await fs.readFile(join(workspace, 'CLAUDE.md'), 'utf-8')).toBe('human rules\n')
  })
})
