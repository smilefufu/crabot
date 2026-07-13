import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('tmp-page server source', () => {
  it('passes page_id to deliver_page_feedback', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../builtins/skills/tmp-page/scripts/server.cjs'),
      'utf8',
    )

    expect(source).toContain('wakeOwnerTask(meta && meta.owner_task_id, id)')
    expect(source).toContain("await rpc(agent.port, 'deliver_page_feedback', { task_id: taskId, page_id: pageId })")
  })

  it('does not ship the legacy shell launcher', () => {
    expect(existsSync(path.resolve(__dirname, '../builtins/skills/tmp-page/scripts/start-server.sh'))).toBe(false)
  })
})
