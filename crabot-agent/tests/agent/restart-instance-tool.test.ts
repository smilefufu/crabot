/**
 * 旧 restart_instance (fire-and-forget) 工具测试。
 *
 * 2026-06-27：工具已改名为 request_restart，导出名改为 createRequestRestartTool，
 * 签名也重构（去掉 crabotHome/spawn，改为 requestRestart 回调）。
 * 新测试见 request-restart-tool.test.ts。
 */
import { describe, it } from 'vitest'

describe('restart_instance（已迁移，见 request-restart-tool.test.ts）', () => {
  it('旧工具已移除，测试见 request-restart-tool.test.ts', () => {
    // 占位：实际测试覆盖在 request-restart-tool.test.ts
  })
})
