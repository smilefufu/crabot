import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 包根：tests/ 的上一级
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ALLOW = 'src/core/data-paths.ts'

describe('防漂移：除 data-paths.ts 外不得裸读 process.env.DATA_DIR', () => {
  it('扫描 src（排除测试文件与解析入口）', () => {
    let hits: string[] = []
    try {
      hits = execSync('git grep -ln "process.env.DATA_DIR" -- src', {
        cwd: PKG_ROOT,
        encoding: 'utf-8',
      })
        .trim()
        .split('\n')
        .filter(Boolean)
    } catch {
      hits = [] // git grep 无命中时退出码非 0
    }
    const offenders = hits.filter((f) => !f.endsWith('.test.ts') && f !== ALLOW)
    expect(
      offenders,
      `这些文件裸读了 process.env.DATA_DIR，应改走 data-paths 入口：\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
