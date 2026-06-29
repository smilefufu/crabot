import { describe, it, expect } from 'vitest'
import * as path from 'path'
import * as os from 'os'
import { resolvePath } from '../../../src/engine/tools/utils'

// resolvePath 是所有吃路径工具（Read/Write/Edit/Glob/Grep/set_cwd）的唯一解析入口，
// 在这里锁定它的契约，尤其是 `~` 展开——m2u 实测过 `~/x` 被拼成 cwd/~/x → ENOENT。
describe('resolvePath', () => {
  const cwd = '/tmp/project'

  it('returns an absolute path unchanged', () => {
    expect(resolvePath(cwd, '/etc/hosts')).toBe('/etc/hosts')
  })

  it('resolves a relative path against cwd', () => {
    expect(resolvePath(cwd, 'src/index.ts')).toBe(path.join(cwd, 'src/index.ts'))
  })

  it('expands a bare ~ to home', () => {
    expect(resolvePath(cwd, '~')).toBe(os.homedir())
  })

  it('expands a leading ~/ to home (no literal ~ left in result)', () => {
    const out = resolvePath(cwd, '~/codes/foo')
    expect(out).toBe(path.join(os.homedir(), 'codes/foo'))
    expect(out).not.toContain('/~/')
  })

  it('does not treat a mid-path ~ as home', () => {
    // 只有前导 `~` / `~/` 才展开；文件名里含 `~`（如备份文件）不动。
    expect(resolvePath(cwd, 'foo~bar')).toBe(path.join(cwd, 'foo~bar'))
  })
})
