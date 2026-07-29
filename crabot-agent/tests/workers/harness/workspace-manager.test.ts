import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { WorkspaceManager, InvalidWorkspaceError } from '../../../src/workers/harness/workspace-manager'

describe('WorkspaceManager', () => {
  let root: string
  let manager: WorkspaceManager

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'workspace-manager-test-'))
    manager = new WorkspaceManager(root)
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  describe('默认行为：缺省创建 <root>/<taskId> 且幂等', () => {
    it('缺省 requested 时创建 <root>/<taskId> 目录', async () => {
      const ws = await manager.resolve('task-1')
      expect(ws.root).toBe(resolve(root, 'task-1'))

      // 验证目录已创建
      const stat = await fs.stat(ws.root)
      expect(stat.isDirectory()).toBe(true)
    })

    it('重复调用同一 taskId 幂等', async () => {
      const ws1 = await manager.resolve('task-1')
      const ws2 = await manager.resolve('task-1')
      expect(ws1.root).toBe(ws2.root)

      // 验证只有一个目录
      const stat = await fs.stat(ws1.root)
      expect(stat.isDirectory()).toBe(true)
    })

    it('多个不同 taskId 分别创建各自目录', async () => {
      const ws1 = await manager.resolve('task-1')
      const ws2 = await manager.resolve('task-2')
      expect(ws1.root).not.toBe(ws2.root)

      const stat1 = await fs.stat(ws1.root)
      const stat2 = await fs.stat(ws2.root)
      expect(stat1.isDirectory()).toBe(true)
      expect(stat2.isDirectory()).toBe(true)
    })
  })

  describe('requested 校验：绝对路径且已存在的目录', () => {
    it('requested 是已存在的绝对目录路径时通过', async () => {
      const externalDir = await fs.mkdtemp(join(tmpdir(), 'external-ws-'))
      try {
        const ws = await manager.resolve('task-1', externalDir)
        expect(ws.root).toBe(externalDir)
      } finally {
        await fs.rm(externalDir, { recursive: true, force: true })
      }
    })
  })

  describe('requested 校验：拒绝相对路径', () => {
    it('相对路径应被拒绝', async () => {
      await expect(manager.resolve('task-1', './relative/path')).rejects.toThrow(InvalidWorkspaceError)
    })

    it('包含 .. 的相对路径应被拒绝', async () => {
      await expect(manager.resolve('task-1', '../parent')).rejects.toThrow(InvalidWorkspaceError)
    })
  })

  describe('requested 校验：拒绝不存在的目录', () => {
    it('不存在的路径应被拒绝', async () => {
      const nonExistent = resolve(tmpdir(), 'non-existent-dir-12345')
      await expect(manager.resolve('task-1', nonExistent)).rejects.toThrow(InvalidWorkspaceError)
    })
  })

  describe('requested 校验：拒绝指向文件的路径', () => {
    it('指向文件的路径应被拒绝', async () => {
      const filePath = join(root, 'test-file.txt')
      await fs.writeFile(filePath, 'test')
      await expect(manager.resolve('task-1', filePath)).rejects.toThrow(InvalidWorkspaceError)
    })
  })

  describe('requested 校验：拒绝含 \\0 的路径', () => {
    it('含有 null byte 的路径应被拒绝', async () => {
      const pathWithNull = '/tmp/path\0with\0null'
      await expect(manager.resolve('task-1', pathWithNull)).rejects.toThrow(InvalidWorkspaceError)
    })
  })

  describe('requested 校验：防串台 - 拒绝其他 taskId 的目录', () => {
    it('落在 <root>/<其他 taskId> 的路径应被拒绝', async () => {
      // 先创建 task-2 的目录
      const task2Dir = resolve(root, 'task-2')
      await fs.mkdir(task2Dir, { recursive: true })

      // task-1 试图请求 task-2 的目录应被拒绝
      await expect(manager.resolve('task-1', task2Dir)).rejects.toThrow(InvalidWorkspaceError)
    })

    it('落在 <root>/<其他 taskId> 子目录的路径应被拒绝', async () => {
      // 先创建 task-2 的子目录
      const task2SubDir = resolve(root, 'task-2', 'subdir')
      await fs.mkdir(task2SubDir, { recursive: true })

      // task-1 试图请求 task-2 的子目录应被拒绝
      await expect(manager.resolve('task-1', task2SubDir)).rejects.toThrow(InvalidWorkspaceError)
    })
  })

  describe('requested 校验：允许自己的 taskId 目录', () => {
    it('落在 <root>/<自己的 taskId> 的路径应通过', async () => {
      const task1Dir = resolve(root, 'task-1')
      await fs.mkdir(task1Dir, { recursive: true })

      const ws = await manager.resolve('task-1', task1Dir)
      expect(ws.root).toBe(task1Dir)
    })

    it('落在 <root>/<自己的 taskId> 子目录的路径应通过', async () => {
      const task1SubDir = resolve(root, 'task-1', 'subdir')
      await fs.mkdir(task1SubDir, { recursive: true })

      const ws = await manager.resolve('task-1', task1SubDir)
      expect(ws.root).toBe(task1SubDir)
    })
  })

  describe('错误报告：InvalidWorkspaceError 应含 reason 字段', () => {
    it('relative path 错误应含 reason', async () => {
      try {
        await manager.resolve('task-1', './relative')
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidWorkspaceError)
        expect((err as InvalidWorkspaceError).reason).toBeDefined()
        expect(typeof (err as InvalidWorkspaceError).reason).toBe('string')
      }
    })

    it('non-existent path 错误应含 reason', async () => {
      try {
        await manager.resolve('task-1', '/tmp/non-existent-12345')
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidWorkspaceError)
        expect((err as InvalidWorkspaceError).reason).toBeDefined()
      }
    })

    it('null byte 错误应含 reason', async () => {
      try {
        await manager.resolve('task-1', '/tmp/path\0null')
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidWorkspaceError)
        expect((err as InvalidWorkspaceError).reason).toBeDefined()
      }
    })

    it('other task 错误应含 reason', async () => {
      const otherTaskDir = resolve(root, 'task-2')
      await fs.mkdir(otherTaskDir, { recursive: true })

      try {
        await manager.resolve('task-1', otherTaskDir)
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidWorkspaceError)
        expect((err as InvalidWorkspaceError).reason).toBeDefined()
      }
    })
  })

  describe('requested 校验：防串台 - 符号链接绕过', () => {
    it('root 外的软链指向其他 taskId 目录应被拒绝（PoC：符号链接绕过边界校验）', async () => {
      const task2Dir = resolve(root, 'task-2')
      await fs.mkdir(task2Dir, { recursive: true })

      const outsideDir = await fs.mkdtemp(join(tmpdir(), 'symlink-poc-'))
      const linkPath = join(outsideDir, 'link-to-task-2')
      try {
        await fs.symlink(task2Dir, linkPath, 'dir')
        await expect(manager.resolve('task-1', linkPath)).rejects.toThrow(InvalidWorkspaceError)
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true })
      }
    })

    it('软链指向自己 taskId 的目录应被允许，返回 realpath', async () => {
      const task1Dir = resolve(root, 'task-1')
      await fs.mkdir(task1Dir, { recursive: true })

      const outsideDir = await fs.mkdtemp(join(tmpdir(), 'symlink-self-'))
      const linkPath = join(outsideDir, 'link-to-task-1')
      try {
        await fs.symlink(task1Dir, linkPath, 'dir')
        const ws = await manager.resolve('task-1', linkPath)
        expect(ws.root).toBe(await fs.realpath(task1Dir))
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true })
      }
    })

    it('root 本身是软链时，合法路径不应被误拒（两侧都要 realpath 再比较）', async () => {
      const realRoot = await fs.mkdtemp(join(tmpdir(), 'real-root-'))
      const rootLinkParent = await fs.mkdtemp(join(tmpdir(), 'root-link-parent-'))
      const rootLink = join(rootLinkParent, 'root-link')
      try {
        await fs.symlink(realRoot, rootLink, 'dir')
        const linkedManager = new WorkspaceManager(rootLink)

        const task1Dir = resolve(realRoot, 'task-1')
        await fs.mkdir(task1Dir, { recursive: true })

        // 通过 root 软链路径请求，应通过（不因 root 是软链而误判越界）
        const requestedViaLink = resolve(rootLink, 'task-1')
        const ws = await linkedManager.resolve('task-1', requestedViaLink)
        expect(ws.root).toBe(await fs.realpath(task1Dir))
      } finally {
        await fs.rm(realRoot, { recursive: true, force: true })
        await fs.rm(rootLinkParent, { recursive: true, force: true })
      }
    })
  })

  describe('constructor 默认 root', () => {
    it('不指定 root 时应使用 getWorkspacesRootDir()', async () => {
      // 临时更改环境变量来测试
      const oldEnv = process.env.WORKER_WORKSPACES_DIR
      try {
        const testDir = await fs.mkdtemp(join(tmpdir(), 'workspaces-root-'))
        process.env.WORKER_WORKSPACES_DIR = testDir
        const mgr = new WorkspaceManager()
        const ws = await mgr.resolve('task-default')
        expect(ws.root).toBe(resolve(testDir, 'task-default'))
        await fs.rm(testDir, { recursive: true, force: true })
      } finally {
        if (oldEnv !== undefined) {
          process.env.WORKER_WORKSPACES_DIR = oldEnv
        } else {
          delete process.env.WORKER_WORKSPACES_DIR
        }
      }
    })
  })
})
