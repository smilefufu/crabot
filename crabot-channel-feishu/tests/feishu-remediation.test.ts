import { describe, it, expect } from 'vitest'
import { buildFeishuRemediation, writeScopeForPath } from '../src/feishu-remediation.js'

describe('buildFeishuRemediation', () => {
  it('缺 drive scope 时给出授权链接、发版/协作者步骤、转在线文档备选', () => {
    const r = buildFeishuRemediation({ appId: 'cli_x', domain: 'feishu', missingScope: 'drive:drive:readonly' })
    expect(r.grant_url).toContain('cli_x')
    expect(decodeURIComponent(r.grant_url)).toContain('drive:drive:readonly')
    expect(decodeURIComponent(r.grant_url)).not.toContain('im:message')
    expect(r.message).toContain('权限')
    expect(r.steps.join('')).toContain('发布')
    expect(r.steps.join('')).toContain('协作者')
    expect(r.alternatives.join('')).toContain('在线')
  })

  it('grant_url 仅包含单 scope', () => {
    const r = buildFeishuRemediation({ appId: 'cli_x', domain: 'feishu', missingScope: 'wiki:wiki:readonly' })
    const decoded = decodeURIComponent(r.grant_url)
    expect(decoded).toContain('wiki:wiki:readonly')
    expect(decoded).not.toContain(',')
  })

  it('feishu_code=41050 时文案说明 scope 仅必要条件、协作者、外部租户策略，保留诊断字段', () => {
    const r = buildFeishuRemediation({ appId: 'cli_x', domain: 'feishu', missingScope: 'docx:document:readonly', feishu_code: 41050, feishu_message: 'no user authority' })
    expect(r.message).toContain('必要条件')
    expect(r.message).toContain('协作者')
    expect(r.message).toContain('外部租户')
    expect(r.steps.some(s => s.includes('外部租户'))).toBe(true)
    expect(r.feishu_code).toBe(41050)
    expect(r.feishu_message).toBe('no user authority')
  })

  it('保留 feishu_code / feishu_message 诊断字段', () => {
    const r = buildFeishuRemediation({
      appId: 'cli_x', domain: 'feishu', missingScope: 'drive:drive:readonly',
      feishu_code: 99999,
      feishu_message: 'subscriber number limit',
    })
    expect(r.feishu_code).toBe(99999)
    expect(r.feishu_message).toBe('subscriber number limit')
  })

  it('read 备选包含 fetch_media 下载 Word/群附件', () => {
    const r = buildFeishuRemediation({ appId: 'cli_x', domain: 'feishu', missingScope: 'drive:drive:readonly' })
    expect(r.alternatives.some(a => a.includes('fetch_media'))).toBe(true)
    expect(r.alternatives.some(a => a.includes('群附件'))).toBe(true)
    expect(r.alternatives.some(a => a.includes('docx'))).toBe(true)
    expect(r.alternatives.some(a => a.includes('正文'))).toBe(true)
  })
})

describe('writeScopeForPath', () => {
  it('按 path 前缀映射写 scope', () => {
    expect(writeScopeForPath('/open-apis/docx/v1/documents/x')).toBe('docx:document')
    expect(writeScopeForPath('/open-apis/sheets/v2/spreadsheets/x')).toBe('sheets:spreadsheet')
    expect(writeScopeForPath('/open-apis/drive/v1/files/x')).toBe('drive:drive')
    expect(writeScopeForPath('/open-apis/wiki/v2/spaces/x')).toBe('wiki:wiki')
    expect(writeScopeForPath('/open-apis/bitable/v1/apps/x')).toBe('bitable:app')
  })
  it('未命中返回 undefined', () => {
    expect(writeScopeForPath('/open-apis/im/v1/messages')).toBeUndefined()
  })
})

describe('buildFeishuRemediation intent=write', () => {
  it('写意图：文案是修改、备选不含转在线文档', () => {
    const r = buildFeishuRemediation({ appId: 'cli_x', domain: 'feishu', missingScope: 'sheets:spreadsheet', intent: 'write' })
    expect(decodeURIComponent(r.grant_url)).toContain('sheets:spreadsheet')
    expect(r.message).toContain('修改')
    expect(r.alternatives.join('')).not.toContain('在线 docx')
  })
})
