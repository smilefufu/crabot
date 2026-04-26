export const ErrorCode = {
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NOT_FOUND: 'NOT_FOUND',
  AMBIGUOUS_REFERENCE: 'AMBIGUOUS_REFERENCE',
  PROVIDER_TEST_FAILED: 'PROVIDER_TEST_FAILED',
  ADMIN_UNREACHABLE: 'ADMIN_UNREACHABLE',
  ADMIN_TIMEOUT: 'ADMIN_TIMEOUT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CONFIRMATION_INVALID: 'CONFIRMATION_INVALID',
  UNDO_STALE: 'UNDO_STALE',
  UNDO_EXPIRED: 'UNDO_EXPIRED',
  UNDO_EMPTY: 'UNDO_EMPTY',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type ErrorCodeName = keyof typeof ErrorCode

const EXIT_CODE_MAP: Record<ErrorCodeName, number> = {
  INVALID_ARGUMENT: 1,
  NOT_FOUND: 1,
  AMBIGUOUS_REFERENCE: 1,
  PROVIDER_TEST_FAILED: 1,
  UNDO_STALE: 1,
  UNDO_EXPIRED: 1,
  UNDO_EMPTY: 1,
  ADMIN_UNREACHABLE: 2,
  ADMIN_TIMEOUT: 2,
  INTERNAL_ERROR: 2,
  PERMISSION_DENIED: 3,
  CONFIRMATION_INVALID: 4,
}

export function exitCodeFor(code: ErrorCodeName): number {
  return EXIT_CODE_MAP[code]
}

export class CliError extends Error {
  readonly exitCode: number
  constructor(
    readonly code: ErrorCodeName,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.exitCode = exitCodeFor(code)
  }
  toJson() {
    return { error: { code: this.code, message: this.message, details: this.details ?? {} } }
  }
}

export function fromHttpError(
  status: number,
  message: string,
  details?: Record<string, unknown>,
): CliError {
  if (status === 404) return new CliError('NOT_FOUND', message, details)
  if (status === 401 || status === 403) return new CliError('PERMISSION_DENIED', message, details)
  return new CliError('INTERNAL_ERROR', message, { ...details, upstream_status: status })
}
