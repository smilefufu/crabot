import { describe, it, expect } from 'vitest'
import { CliError, exitCodeFor, fromHttpError } from './errors.js'

describe('CliError', () => {
  it('携带 code/message/details/exitCode', () => {
    const e = new CliError('NOT_FOUND', 'not found', { domain: 'provider', ref: 'x' })
    expect(e.code).toBe('NOT_FOUND')
    expect(e.exitCode).toBe(1)
    expect(e.toJson()).toEqual({
      error: { code: 'NOT_FOUND', message: 'not found', details: { domain: 'provider', ref: 'x' } },
    })
  })
  it('无 details 时 toJson 返回空对象', () => {
    const e = new CliError('INTERNAL_ERROR', 'oops')
    expect(e.toJson().error.details).toEqual({})
  })
})

describe('exitCodeFor', () => {
  it('USER_ERROR 类返回 1', () => {
    expect(exitCodeFor('NOT_FOUND')).toBe(1)
    expect(exitCodeFor('AMBIGUOUS_REFERENCE')).toBe(1)
    expect(exitCodeFor('UNDO_STALE')).toBe(1)
    expect(exitCodeFor('UNDO_EXPIRED')).toBe(1)
    expect(exitCodeFor('UNDO_EMPTY')).toBe(1)
    expect(exitCodeFor('INVALID_ARGUMENT')).toBe(1)
  })
  it('系统类返回 2', () => {
    expect(exitCodeFor('ADMIN_UNREACHABLE')).toBe(2)
    expect(exitCodeFor('ADMIN_TIMEOUT')).toBe(2)
    expect(exitCodeFor('INTERNAL_ERROR')).toBe(2)
  })
  it('权限类返回 3', () => {
    expect(exitCodeFor('PERMISSION_DENIED')).toBe(3)
  })
  it('confirmation 类返回 4', () => {
    expect(exitCodeFor('CONFIRMATION_INVALID')).toBe(4)
  })
})

describe('fromHttpError', () => {
  it('404 → NOT_FOUND', () => {
    expect(fromHttpError(404, 'not found').code).toBe('NOT_FOUND')
  })
  it('401/403 → PERMISSION_DENIED', () => {
    expect(fromHttpError(401, 'unauthorized').code).toBe('PERMISSION_DENIED')
    expect(fromHttpError(403, 'forbidden').code).toBe('PERMISSION_DENIED')
  })
  it('500 → INTERNAL_ERROR，details.upstream_status=500', () => {
    const e = fromHttpError(500, 'oops')
    expect(e.code).toBe('INTERNAL_ERROR')
    expect(e.details).toMatchObject({ upstream_status: 500 })
  })
})
