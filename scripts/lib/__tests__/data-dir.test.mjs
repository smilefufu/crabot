import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { resolveDataDir } from '../data-dir.mjs'

describe('resolveDataDir', () => {
  it('env DATA_DIR 优先级最高', () => {
    expect(resolveDataDir({ envValue: '/explicit/path', offset: 0 }))
      .toBe('/explicit/path')
    expect(resolveDataDir({ envValue: '/explicit/path', offset: 100 }))
      .toBe('/explicit/path')
  })

  it('env DATA_DIR 即使 $REPO/data/admin 存在也优先', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'crabot-resolvedd-'))
    try {
      mkdirSync(join(repoRoot, 'data', 'admin'), { recursive: true })
      expect(resolveDataDir({ envValue: '/explicit', offset: 0, repoRoot }))
        .toBe('/explicit')
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it('offset=0 时默认 ~/.crabot/data', () => {
    expect(resolveDataDir({ envValue: undefined, offset: 0 }))
      .toBe(resolve(homedir(), '.crabot/data'))
  })

  it('offset>0 时默认 ~/.crabot/data-<OFF>', () => {
    expect(resolveDataDir({ envValue: undefined, offset: 100 }))
      .toBe(resolve(homedir(), '.crabot/data-100'))
    expect(resolveDataDir({ envValue: undefined, offset: 200 }))
      .toBe(resolve(homedir(), '.crabot/data-200'))
  })

  describe('仓库目录不参与默认解析', () => {
    let repoRoot

    beforeEach(() => {
      repoRoot = mkdtempSync(join(tmpdir(), 'crabot-resolvedd-'))
    })
    afterEach(() => {
      rmSync(repoRoot, { recursive: true, force: true })
    })

    it('repoRoot + offset=0 + $REPO/data/admin 存在 → 仍用 ~/.crabot/data', () => {
      mkdirSync(join(repoRoot, 'data', 'admin'), { recursive: true })
      expect(resolveDataDir({ envValue: undefined, offset: 0, repoRoot }))
        .toBe(resolve(homedir(), '.crabot/data'))
    })
  })
})
