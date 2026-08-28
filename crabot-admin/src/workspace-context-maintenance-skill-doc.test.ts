import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('workspace-context-maintenance skill doc', () => {
  it('uses the current workspace state without depending on retired cwd tools', () => {
    const doc = readFileSync(
      path.resolve(__dirname, '../builtin-skills/workspace-context-maintenance/SKILL.md'),
      'utf8',
    )

    expect(doc).toContain('当前 workspace 中未发现 `AGENTS.md`')
    expect(doc).toContain('返回给 Manager 的工作总结')
    expect(doc).not.toContain('set_cwd')
  })
})
