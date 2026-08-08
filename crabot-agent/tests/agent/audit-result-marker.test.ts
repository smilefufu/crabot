import { describe, it, expect } from 'vitest'
import {
  buildAuditPendingMarker,
  buildAuditResultMarker,
  buildAuditAbortedMarker,
  parseSystemMarker,
} from '../../src/agent/audit-result-marker.ts'

describe('audit-result-marker', () => {
  it('builds audit_pending marker with audit_id', () => {
    const text = buildAuditPendingMarker({ auditId: 'audit-abc123' })
    expect(text).toContain('<audit_pending>')
    expect(text).toContain('audit-abc123')
    expect(text).toContain('自动挂起')
    expect(text).not.toContain('timeout_ms')
  })

  it('builds audit_result(pass) marker', () => {
    const text = buildAuditResultMarker({
      auditId: 'audit-abc123',
      pass: true,
      failedCriteria: [],
      detailedReport: '',
    })
    expect(text).toContain('<audit_result>')
    expect(text).toContain('audit-abc123')
    expect(text).toContain('"pass":true')
  })

  it('builds audit_result(fail) marker with detailed report', () => {
    const text = buildAuditResultMarker({
      auditId: 'audit-abc123',
      pass: false,
      failedCriteria: ['c-deployed'],
      detailedReport: '## 不达标\n- c-deployed: server2 未部署',
    })
    expect(text).toContain('"pass":false')
    expect(text).toContain('c-deployed')
    expect(text).toContain('server2 未部署')
  })

  it('builds audit_aborted marker with reason', () => {
    const text = buildAuditAbortedMarker({ auditId: 'audit-abc123', reason: 'goal_revised' })
    expect(text).toContain('<audit_aborted>')
    expect(text).toContain('goal_revised')
  })

  it('parseSystemMarker identifies three marker types plus null fallback', () => {
    expect(parseSystemMarker(buildAuditPendingMarker({ auditId: 'a1' }))?.type).toBe('audit_pending')
    expect(parseSystemMarker(buildAuditResultMarker({ auditId: 'a1', pass: true, failedCriteria: [], detailedReport: '' }))?.type).toBe('audit_result')
    expect(parseSystemMarker(buildAuditAbortedMarker({ auditId: 'a1', reason: 'x' }))?.type).toBe('audit_aborted')
    expect(parseSystemMarker('plain user message')).toBeNull()
  })

  it('parseSystemMarker round-trips audit_result fields', () => {
    const built = buildAuditResultMarker({
      auditId: 'a1',
      pass: false,
      failedCriteria: ['c-x', 'c-y'],
      detailedReport: 'report',
    })
    const parsed = parseSystemMarker(built)
    expect(parsed?.type).toBe('audit_result')
    if (parsed?.type === 'audit_result') {
      expect(parsed.auditId).toBe('a1')
      expect(parsed.pass).toBe(false)
      expect(parsed.failedCriteria).toEqual(['c-x', 'c-y'])
      expect(parsed.detailedReport).toBe('report')
    }
  })

  it('parseSystemMarker returns null for malformed audit_result body', () => {
    expect(parseSystemMarker('<audit_result>not-json</audit_result>')).toBeNull()
  })

  it('parseSystemMarker throws on forbidden literal in detailedReport at build time', () => {
    expect(() =>
      buildAuditResultMarker({
        auditId: 'a1',
        pass: false,
        failedCriteria: [],
        detailedReport: 'agent wrote </audit_result> in its report',
      }),
    ).toThrow(/forbidden literal/)
  })
})
