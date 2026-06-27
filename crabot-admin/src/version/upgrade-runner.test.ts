import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readUpgradeStatus, canUpgrade, isUpgradeInProgress, writeUpgradeStarting, startUpgrade } from './upgrade-runner.js'
import type { VersionState } from './types.js'

function tmpDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'crabot-up-'))
  mkdirSync(join(d, 'admin'), { recursive: true })
  return join(d, 'admin')
}

describe('readUpgradeStatus', () => {
  it('文件不存在返回 null', () => {
    expect(readUpgradeStatus(tmpDataDir())).toBeNull()
  })
  it('读已写入的状态', () => {
    const dir = tmpDataDir()
    writeFileSync(join(dir, 'upgrade-status.json'), JSON.stringify({ phase: 'done', started_at: 'x' }))
    expect(readUpgradeStatus(dir)?.phase).toBe('done')
  })
})

describe('isUpgradeInProgress', () => {
  it('phase=upgrading 且 started_at 是当前时间 → true', () => {
    const dir = tmpDataDir()
    writeFileSync(join(dir, 'upgrade-status.json'), JSON.stringify({ phase: 'upgrading', started_at: new Date().toISOString() }))
    expect(isUpgradeInProgress(dir)).toBe(true)
  })
  it('phase=upgrading 且 started_at 是 11 分钟前 → false（stale lock）', () => {
    const dir = tmpDataDir()
    const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString()
    writeFileSync(join(dir, 'upgrade-status.json'), JSON.stringify({ phase: 'upgrading', started_at: stale }))
    expect(isUpgradeInProgress(dir)).toBe(false)
  })
  it('started_at 非法字符串 → false', () => {
    const dir = tmpDataDir()
    writeFileSync(join(dir, 'upgrade-status.json'), JSON.stringify({ phase: 'upgrading', started_at: 'not-a-date' }))
    expect(isUpgradeInProgress(dir)).toBe(false)
  })
  it('phase=done → false', () => {
    const dir = tmpDataDir()
    writeFileSync(join(dir, 'upgrade-status.json'), JSON.stringify({ phase: 'done', started_at: new Date().toISOString() }))
    expect(isUpgradeInProgress(dir)).toBe(false)
  })
})

describe('writeUpgradeStarting', () => {
  it('同步写 upgrading 状态，isUpgradeInProgress 立即为 true', () => {
    const dir = tmpDataDir()
    writeUpgradeStarting(dir, 'v1.0.0')
    const s = readUpgradeStatus(dir)
    expect(s?.phase).toBe('upgrading')
    expect(s?.from_version).toBe('v1.0.0')
    expect(isUpgradeInProgress(dir)).toBe(true)
  })
  it('覆盖上一次残留的 done 状态（竞态修复核心）', () => {
    const dir = tmpDataDir()
    writeFileSync(join(dir, 'upgrade-status.json'), JSON.stringify({ phase: 'done', started_at: 'x', finished_at: 'y' }))
    writeUpgradeStarting(dir)
    expect(readUpgradeStatus(dir)?.phase).toBe('upgrading')
    expect(readUpgradeStatus(dir)?.finished_at).toBeUndefined()
  })
})

describe('canUpgrade', () => {
  const base = (over: Partial<VersionState>): VersionState => ({
    current_version: 'a', latest_version: 'b', upgrade_available: true,
    upgrade_capability: 'release', last_checked: null, checking: false, ...over,
  })
  it('release 有更新 → 允许', () => {
    expect(canUpgrade(base({})).ok).toBe(true)
  })
  it('system → 拒绝', () => {
    expect(canUpgrade(base({ upgrade_capability: 'system' })).ok).toBe(false)
  })
  it('source 有 blockers → 拒绝', () => {
    expect(canUpgrade(base({ upgrade_capability: 'source', source_blockers: ['工作区有未提交改动'] })).ok).toBe(false)
  })
  it('source 干净 → 允许', () => {
    expect(canUpgrade(base({ upgrade_capability: 'source', source_blockers: [] })).ok).toBe(true)
  })
  it('无可用更新 → 拒绝', () => {
    expect(canUpgrade(base({ upgrade_available: false })).ok).toBe(false)
  })
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn(() => ({ on: () => {}, unref: () => {} })),
  }
})

describe('startUpgrade：不再覆盖 DATA_DIR（已全局统一为顶层）', () => {
  let spawnMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    const cp = await import('node:child_process')
    spawnMock = cp.spawn as unknown as ReturnType<typeof vi.fn>
    spawnMock.mockClear()
  })

  afterEach(() => {
    delete process.env.DATA_DIR
  })

  it('spawn 的 env.DATA_DIR 等于进程当前 DATA_DIR，不做 ../ 偏移', async () => {
    process.env.DATA_DIR = '/home/u/.crabot/data'
    const dir = tmpDataDir()  // .../admin
    startUpgrade('/repo', dir, 'v1')
    const passedEnv = (spawnMock.mock.calls[0][2] as { env: Record<string, string> }).env
    expect(passedEnv.DATA_DIR).toBe('/home/u/.crabot/data')
  })
})
