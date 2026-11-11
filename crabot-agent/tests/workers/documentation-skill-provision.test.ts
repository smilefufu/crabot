import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ClaudeCodeAdapter } from '../../src/workers/claude-code/adapter.js'
import { CodexWorkerAdapter } from '../../src/workers/codex/adapter.js'

describe('同名用户自定义 Skill 的原生装配', () => {
  it.each(['claude', 'codex'] as const)('%s 实际 provision 正文，保留项目规则与非托管 Skill', async impl => {
    const root = await fs.mkdtemp(join(tmpdir(), 'crabot-doc-rules-'))
    const workspace = join(root, 'project')
    const nativeDir = join(workspace, `.${impl}`)
    const skillDir = join(root, 'user-custom-skill')
    try {
      await fs.mkdir(skillDir)
      await fs.writeFile(join(skillDir, 'SKILL.md'), 'User-owned workspace-context-maintenance rule.\n')
      await fs.mkdir(join(nativeDir, 'skills/user-rule'), { recursive: true })
      await fs.mkdir(join(root, 'native-home'))
      await fs.writeFile(join(nativeDir, 'skills/user-rule/SKILL.md'), 'native rule')
      await fs.writeFile(join(workspace, 'AGENTS.md'), 'Project rules stay authoritative.\n')
      execFileSync('git', ['init', '-q'], { cwd: workspace })
      const adapter = impl === 'claude'
        ? new ClaudeCodeAdapter({ dataDir: root, claudeConfigPath: join(root, 'claude.json') })
        : new CodexWorkerAdapter({ dataDir: root, codexHomeSource: join(root, 'native-home') })
      const workflows = ['browser-interaction-test-check', 'web-page-visual-check', 'pptx-source-to-delivery'].map(name => ({
        id: `builtin-skill-${name}`, name, skill_dir: resolve(__dirname, '../../../crabot-admin/builtins/skills', name),
      }))
      const caps = { skills: [{ id: 'workspace-context-maintenance', name: 'workspace-context-maintenance', skill_dir: skillDir }, ...workflows], mcp_servers: [] }
      await adapter.provision({ root: workspace }, caps)
      await adapter.provision({ root: workspace }, caps)
      expect(await fs.readFile(join(nativeDir, 'skills/workspace-context-maintenance/SKILL.md'), 'utf8'))
        .toBe(await fs.readFile(join(skillDir, 'SKILL.md'), 'utf8'))
      for (const workflow of workflows) {
        expect(await fs.readFile(join(nativeDir, 'skills', workflow.name, 'SKILL.md'), 'utf8'))
          .toBe(await fs.readFile(join(workflow.skill_dir, 'SKILL.md'), 'utf8'))
      }
      expect(await fs.readFile(join(nativeDir, 'skills/user-rule/SKILL.md'), 'utf8')).toBe('native rule')
      expect(await fs.readFile(join(workspace, 'AGENTS.md'), 'utf8')).toBe('Project rules stay authoritative.\n')
      await adapter.dispose()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
