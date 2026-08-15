import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WorkerImplementationStore } from './worker-implementation-store.js'

let dir: string
let store: WorkerImplementationStore

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-worker-impl-store-'))
  store = new WorkerImplementationStore(dir)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('WorkerImplementationStore', () => {
  it('新部署原子落 revision 1：builtin enabled/default，CLI disabled 无 connection', async () => {
    const config = await store.load()
    expect(config.revision).toBe(1)
    expect(config.default_impl).toBe('builtin')
    expect(config.implementations.builtin).toEqual({ enabled: true })
    expect(config.implementations['claude-code']).toEqual({ enabled: false })
    expect(config.implementations.codex).toEqual({ enabled: false })
    // 固定 keys：恰好三个
    expect(Object.keys(config.implementations).sort()).toEqual(['builtin', 'claude-code', 'codex'])
    // 二次 load 幂等（不重复加 revision）
    const again = await store.load()
    expect(again.revision).toBe(1)
  })

  it('拒绝缺 key / 多 key 的损坏文件（fail closed，不静默修补）', async () => {
    await store.load()
    const file = path.join(dir, 'config', 'worker-implementations.json')
    const broken = JSON.parse(await fs.readFile(file, 'utf-8'))
    delete broken.implementations.codex
    await fs.writeFile(file, JSON.stringify(broken))
    const fresh = new WorkerImplementationStore(dir)
    await expect(fresh.load()).rejects.toThrow(/worker-implementations/)
  })

  it('revision 必须为正整数、default_impl 必须存在且 enabled', async () => {
    await store.load()
    const file = path.join(dir, 'config', 'worker-implementations.json')
    const broken = JSON.parse(await fs.readFile(file, 'utf-8'))
    broken.default_impl = 'codex' // codex disabled → invalid
    await fs.writeFile(file, JSON.stringify(broken))
    await expect(new WorkerImplementationStore(dir).load()).rejects.toThrow()
  })

  it('validateCandidate：builtin 不得带 connection；CLI connection shape 校验', async () => {
    await store.load()
    const bad1 = {
      revision: 2,
      default_impl: 'builtin' as const,
      implementations: {
        builtin: { enabled: true, connection: { mode: 'native_account' as const } },
        'claude-code': { enabled: false },
        codex: { enabled: false },
      },
    }
    expect(() => store.validateCandidate(bad1)).toThrow(/builtin/)
    const bad2 = {
      revision: 2,
      default_impl: 'builtin' as const,
      implementations: {
        builtin: { enabled: true },
        'claude-code': { enabled: true, connection: { mode: 'bogus' } },
        codex: { enabled: false },
      },
    }
    expect(() => store.validateCandidate(bad2 as never)).toThrow()
    const good = {
      revision: 2,
      default_impl: 'builtin' as const,
      implementations: {
        builtin: { enabled: true },
        'claude-code': { enabled: true, connection: { mode: 'existing_host' as const } },
        codex: { enabled: false },
      },
    }
    expect(() => store.validateCandidate(good)).not.toThrow()
  })

  it('P6-C 过渡 gate：拒绝 default_impl 从 builtin 改走', async () => {
    await store.load()
    const candidate = {
      revision: 2,
      default_impl: 'claude-code' as const,
      implementations: {
        builtin: { enabled: true },
        'claude-code': { enabled: true, connection: { mode: 'existing_host' as const } },
        codex: { enabled: false },
      },
    }
    expect(() => store.validateCandidate(candidate)).toThrow(/default_impl/)
  })
})
