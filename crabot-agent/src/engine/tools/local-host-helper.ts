import { createInterface } from 'node:readline'
import { cleanUpInFlightTemporaryFiles, executeLocalHostOperation } from './local-host-operations'
import { LOCAL_HOST_PROTOCOL_VERSION, isLocalHostOperation, type LocalHostRequest, type LocalHostResponse } from './local-host-protocol'

function writeResponse(response: LocalHostResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`)
}

function exitAfterCleaningTemporaryFiles(exitCode: number): void {
  cleanUpInFlightTemporaryFiles()
  process.exit(exitCode)
}

process.once('SIGTERM', () => exitAfterCleaningTemporaryFiles(143))
process.once('SIGINT', () => exitAfterCleaningTemporaryFiles(130))

async function main(): Promise<void> {
  const lines: string[] = []
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of reader) {
    lines.push(line)
    if (lines.length > 1) throw new Error('expected exactly one request line')
  }
  if (lines.length !== 1) throw new Error('expected one request line')
  const request = JSON.parse(lines[0]) as Partial<LocalHostRequest>
  if (request.protocol_version !== LOCAL_HOST_PROTOCOL_VERSION || typeof request.call_id !== 'string' || !isLocalHostOperation(request.operation)
    || request.input === null || typeof request.input !== 'object' || request.context === null || typeof request.context !== 'object'
    || typeof request.context.cwd !== 'string' || typeof request.context.timezone !== 'string') {
    throw new Error('invalid helper request')
  }
  const outcome = await executeLocalHostOperation(request.operation, request.input as Record<string, unknown>)
  writeResponse({
    protocol_version: LOCAL_HOST_PROTOCOL_VERSION,
    call_id: request.call_id,
    ok: true,
    result: outcome.result,
    ...(outcome.effect ? { effect: outcome.effect } : {}),
  })
}

void main().catch((error: unknown) => {
  process.stderr.write(`[local-host-helper] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
