import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ManagedInstaller } from '../../src/workers/install/managed-installer.js'
import { manifestFor } from '../../src/workers/install/manifests.js'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-managed-install-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

describe('ManagedInstaller（P6-B §8）', () => {
  it('manifest 固定：package/version/命令闭集，不接受外部输入', () => {
    const claude = manifestFor('claude-code')
    expect(claude.packageId).toBe('@anthropic-ai/claude-code')
    expect(claude.pinnedVersion).toMatch(/^2\./)
    expect(manifestFor('codex').packageId).toBe('@openai/codex')
  })

  it('无 active pointer 时 activeBinary 返回 undefined', async () => {
    const installer = new ManagedInstaller(dir)
    expect(await installer.activeBinary('claude-code')).toBeUndefined()
  })

  it('active pointer 越界（指向 versions 目录外）fail closed', async () => {
    const installer = new ManagedInstaller(dir)
    const pointerDir = path.join(dir, 'worker-impls', 'claude-code', 'tools')
    await fs.mkdir(pointerDir, { recursive: true })
    await fs.writeFile(path.join(pointerDir, 'active.json'), JSON.stringify({ version: '1.0.0', binary: '/usr/bin/evil' }))
    await expect(installer.activeBinary('claude-code')).rejects.toThrow(/escapes/)
  })

  it('reconcileOnStartup 清理 staging 残留，保留正式版本目录', async () => {
    const installer = new ManagedInstaller(dir)
    const versions = path.join(dir, 'worker-impls', 'codex', 'tools', 'versions')
    await fs.mkdir(path.join(versions, '0.147.0.staging-123'), { recursive: true })
    await fs.mkdir(path.join(versions, '0.147.0'), { recursive: true })
    await installer.reconcileOnStartup()
    const remaining = await fs.readdir(versions)
    expect(remaining).toEqual(['0.147.0'])
  })

  it('同 impl 并发 install 互斥（WORKER_OPERATION_CONFLICT）', async () => {
    const installer = new ManagedInstaller(dir)
    // install 内部会跑 npm——用 inFlight 占位模拟：先塞一个永不 resolve 的 Promise
    const pending = new Promise(() => {}) as never
    ;(installer as unknown as { inFlight: Map<string, Promise<never>> }).inFlight.set('codex', pending)
    await expect(installer.install('codex')).rejects.toThrow(/in flight|CONFLICT/)
  })
})
