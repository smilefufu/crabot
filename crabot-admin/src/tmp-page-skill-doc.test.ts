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
    expect(doc).toContain('把 `url`、页面用途和希望收集的反馈返回 Manager')
    expect(doc).toContain('页面提交后系统会自动唤醒页面所属 Worker')
    expect(doc).toContain('不要轮询等待页面反馈')
    expect(doc).not.toContain('send_message')
    expect(doc).not.toContain('ask_human')
    expect(doc).not.toContain('obsolete_wait_signal')
  })
})
