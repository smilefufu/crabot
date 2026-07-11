import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('tmp-page skill doc', () => {
  it('points workers to tmp_page tools and not runtime paths', () => {
    const doc = readFileSync(
      path.resolve(__dirname, '../builtins/skills/tmp-page/SKILL.md'),
      'utf8',
    )

    expect(doc).toContain('tmp_page_create')
    expect(doc).toContain('tmp_page_read_events')
    expect(doc).toContain('has_more')
    expect(doc).toContain('tmp_page_delete')
    expect(doc).not.toContain('$DATA_DIR/tmp-pages')
    expect(doc).not.toContain('.crabot/data/tmp-pages')
    expect(doc).not.toContain('events.jsonl')
    expect(doc).not.toContain('CRABOT_TMP_PAGE_PORT')
    expect(doc).not.toContain('_manage')
    expect(doc).not.toContain('start-server.sh')
    expect(doc).toContain('wait_for_signal({ reason: "等 tmp-page 页面反馈", timeout_ms:')
    expect(doc).not.toContain('wait_for_signal({ reason: "等 tmp-page 页面反馈", timeout_ms? })')
  })
})
