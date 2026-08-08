// crabot-agent/src/agent/audit-result-marker.ts

export interface AuditPendingMarker {
  readonly type: 'audit_pending'
  readonly auditId: string
}

export interface AuditResultMarker {
  readonly type: 'audit_result'
  readonly auditId: string
  readonly pass: boolean
  readonly failedCriteria: ReadonlyArray<string>
  readonly detailedReport: string
}

export interface AuditAbortedMarker {
  readonly type: 'audit_aborted'
  readonly auditId: string
  readonly reason: string
}

export type SystemMarker = AuditPendingMarker | AuditResultMarker | AuditAbortedMarker

/**
 * Build a system marker as a tag-wrapped user message. Tag前缀风格与 <sub_agent_notification>
 * 一致，避免给 humanMessageQueue 加结构化 push API。
 *
 * @deprecated 2026-06-10 起 endTurnGate 返回 { kind: 'wait' } 由 engine 直接挂起，
 * 不再注入 audit_pending 文本（spec 2026-06-10-audit-anchor-human-request §4.7）。
 * parseSystemMarker 的 audit_pending 分支保留向后兼容；本函数仅测试在用。
 */
export function buildAuditPendingMarker(params: { auditId: string }): string {
  if (params.auditId.includes('</audit_id>') || params.auditId.includes('</audit_pending>')) {
    throw new Error('buildAuditPendingMarker: auditId contains forbidden literal')
  }
  return [
    '<audit_pending>',
    `<audit_id>${params.auditId}</audit_id>`,
    '<instruction>',
    '你的最终交付正在系统自检中。审核期间系统会自动挂起当前回合；期间如有用户补充指示也会唤醒你。',
    '</instruction>',
    '</audit_pending>',
  ].join('\n')
}

export function buildAuditResultMarker(params: {
  auditId: string
  pass: boolean
  failedCriteria: ReadonlyArray<string>
  detailedReport: string
}): string {
  const FORBIDDEN_IN_REPORT = ['</audit_result>', '</detailed_report>']
  for (const forbidden of FORBIDDEN_IN_REPORT) {
    if (params.detailedReport.includes(forbidden)) {
      throw new Error(
        `buildAuditResultMarker: detailedReport contains forbidden literal "${forbidden}". ` +
        `Sanitize upstream before building marker.`,
      )
    }
  }
  for (const c of params.failedCriteria) {
    if (FORBIDDEN_IN_REPORT.some(f => c.includes(f))) {
      throw new Error(`buildAuditResultMarker: failed_criteria entry contains forbidden tag literal: ${c}`)
    }
  }
  const payload = JSON.stringify({
    audit_id: params.auditId,
    pass: params.pass,
    failed_criteria: params.failedCriteria,
  })
  return [
    '<audit_result>',
    payload,
    '</audit_result>',
    params.detailedReport ? `<detailed_report>\n${params.detailedReport}\n</detailed_report>` : '',
  ].filter(Boolean).join('\n')
}

export function buildAuditAbortedMarker(params: { auditId: string; reason: string }): string {
  const FORBIDDEN_IN_ABORTED = ['</audit_aborted>', '</reason>', '</audit_id>']
  for (const forbidden of FORBIDDEN_IN_ABORTED) {
    if (params.reason.includes(forbidden) || params.auditId.includes(forbidden)) {
      throw new Error(
        `buildAuditAbortedMarker: reason or auditId contains forbidden literal "${forbidden}".`,
      )
    }
  }
  return [
    '<audit_aborted>',
    `<audit_id>${params.auditId}</audit_id>`,
    `<reason>${params.reason}</reason>`,
    '</audit_aborted>',
  ].join('\n')
}

/** Parse a humanQueue message and identify if it's a system marker. */
export function parseSystemMarker(text: string): SystemMarker | null {
  if (!text || typeof text !== 'string') return null

  if (text.startsWith('<audit_pending>')) {
    const idMatch = /<audit_id>([^<]+)<\/audit_id>/.exec(text)
    return idMatch ? { type: 'audit_pending', auditId: idMatch[1] } : null
  }

  if (text.startsWith('<audit_result>')) {
    const jsonMatch = /<audit_result>\s*([\s\S]+?)\s*<\/audit_result>/.exec(text)
    if (!jsonMatch) return null
    try {
      const payload = JSON.parse(jsonMatch[1]) as {
        audit_id?: string
        pass?: boolean
        failed_criteria?: ReadonlyArray<string>
      }
      const reportMatch = /<detailed_report>\n([\s\S]+?)\n<\/detailed_report>/.exec(text)
      return {
        type: 'audit_result',
        auditId: payload.audit_id ?? '',
        pass: payload.pass === true,
        failedCriteria: Array.isArray(payload.failed_criteria) ? payload.failed_criteria.map(String) : [],
        detailedReport: reportMatch ? reportMatch[1] : '',
      }
    } catch {
      return null
    }
  }

  if (text.startsWith('<audit_aborted>')) {
    const idMatch = /<audit_id>([^<]+)<\/audit_id>/.exec(text)
    const reasonMatch = /<reason>([^<]+)<\/reason>/.exec(text)
    return idMatch
      ? { type: 'audit_aborted', auditId: idMatch[1], reason: reasonMatch ? reasonMatch[1] : '' }
      : null
  }

  return null
}
