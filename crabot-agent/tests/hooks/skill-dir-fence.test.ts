import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getInternalHandler } from '../../src/hooks/internal-handlers.js'
import type { InternalHandlerContext } from '../../src/hooks/types.js'

// agent 数据目录（由 CRABOT_AGENT_DATA_DIR 注入，等价于 <root>/data/agent）；
// admin skills 在同级 <root>/data/admin/skills（通过 getAdminDataDir() = join(agentDir, '..', 'admin') 推导）
const AGENT_DATA_DIR = '/var/crabot/data/agent'
const ADMIN_SKILLS_DIR = '/var/crabot/data/admin/skills'

function makeCtx(): InternalHandlerContext {
  return {
    workingDirectory: '/tmp/test',
    senderIsMaster: false,
    contentReviewer: vi.fn(),
  }
}

describe('skill-dir-fence hook', () => {
  beforeEach(() => {
    vi.stubEnv('CRABOT_AGENT_DATA_DIR', AGENT_DATA_DIR)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('Write 命中 admin skills/<name>/SKILL.md → block，提示走 crabot skill update', async () => {
    const handler = getInternalHandler('skill-dir-fence')!
    const result = await handler(
      { event: 'PreToolUse', toolInput: { file_path: `${ADMIN_SKILLS_DIR}/video-app-skill/SKILL.md` } },
      makeCtx(),
    )
    expect(result.action).toBe('block')
    expect(result.message).toMatch(/crabot skill update/)
  })

  it('Write 命中 skills 子目录的 references 也 block（防止偷绕）', async () => {
    const handler = getInternalHandler('skill-dir-fence')!
    const result = await handler(
      { event: 'PreToolUse', toolInput: { file_path: `${ADMIN_SKILLS_DIR}/x/references/cheatsheet.md` } },
      makeCtx(),
    )
    expect(result.action).toBe('block')
  })

  it('Edit 写到 agent 自己的 DATA_DIR 下（同名陷阱 <root>/data/agent/admin/skills）→ continue', async () => {
    // 回归测试：早期 fence 用 path.join(DATA_DIR, 'admin', 'skills') 把 agent DATA_DIR 当顶层 data
    // 算出 <root>/data/agent/admin/skills，结果 fence 在生产环境永远 no-op。这条断言确保该路径
    // **不**触发 fence——真正的 skills 在 <root>/data/admin/skills（被 finding 1 修好的方向）。
    const handler = getInternalHandler('skill-dir-fence')!
    const result = await handler(
      { event: 'PreToolUse', toolInput: { file_path: `${AGENT_DATA_DIR}/admin/skills/foo.md` } },
      makeCtx(),
    )
    expect(result.action).toBe('continue')
  })

  it('Edit 仓库内任意其他文件 → continue', async () => {
    const handler = getInternalHandler('skill-dir-fence')!
    const result = await handler(
      { event: 'PreToolUse', toolInput: { file_path: '/var/crabot/data/admin/something-else.json' } },
      makeCtx(),
    )
    expect(result.action).toBe('continue')
  })

  it('toolInput 无 file_path → continue', async () => {
    const handler = getInternalHandler('skill-dir-fence')!
    const result = await handler({ event: 'PreToolUse', toolInput: {} }, makeCtx())
    expect(result.action).toBe('continue')
  })

  it('Edit 直接命中 skills root 自身 → block', async () => {
    const handler = getInternalHandler('skill-dir-fence')!
    const result = await handler(
      { event: 'PreToolUse', toolInput: { file_path: ADMIN_SKILLS_DIR } },
      makeCtx(),
    )
    expect(result.action).toBe('block')
  })
})
