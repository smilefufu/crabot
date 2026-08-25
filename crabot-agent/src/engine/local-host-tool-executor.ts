import { existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ToolCallContext, ToolCallResult } from './types'
import { runHostProcess } from './host-process'
import { buildChildEnv } from '../core/runtime-env'
import {
  LOCAL_HOST_PROTOCOL_VERSION,
  isReadObservation,
  type LocalHostOperation,
  type LocalHostResponse,
  type ReadObservation,
} from './tools/local-host-protocol'

const HELPER_STDOUT_LIMIT = 32 * 1024 * 1024 // Read image transport keeps its existing 20 MiB contract.
const HELPER_STDERR_LIMIT = 64 * 1024

export interface LocalHostExecution {
  readonly result: ToolCallResult
  readonly effect?: ReadObservation
}

function helperLaunch(): { readonly argv: readonly [string, ...string[]]; readonly env?: Record<string, string> } {
  const compiled = path.join(__dirname, 'tools', 'local-host-helper.js')
  if (existsSync(compiled)) return { argv: [process.execPath, compiled] }

  const source = path.join(__dirname, 'tools', 'local-host-helper.ts')
  if (existsSync(source)) {
    return {
      argv: [process.execPath, '-r', require.resolve('ts-node/register/transpile-only'), source],
      // The tool cwd is intentionally the caller's workspace, so ts-node must not discover an
      // unrelated parent tsconfig from that directory.
      env: buildChildEnv({
        TS_NODE_PROJECT: path.resolve(__dirname, '..', '..', 'tsconfig.json'),
        TS_NODE_EXPERIMENTAL_RESOLVER: 'true',
      }),
    }
  }
  throw new Error('local host helper entrypoint is missing')
}

function protocolFailure(operation: LocalHostOperation, message: string): LocalHostExecution {
  if (operation === 'write' || operation === 'edit') return uncertainFailure(operation, `helper protocol error: ${message}`)
  return { result: { output: `Local tool helper protocol error: ${message}`, isError: true } }
}

function uncertainFailure(operation: LocalHostOperation, reason: string): LocalHostExecution {
  const sideEffect = operation === 'write' || operation === 'edit'
  const prefix = sideEffect ? 'Local tool execution result is unknown' : 'Local tool execution failed'
  return { result: { output: `${prefix} (${operation}): ${reason}`, isError: true } }
}

function parseResponse(stdout: string, callId: string, operation: LocalHostOperation): LocalHostExecution {
  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0)
  if (lines.length !== 1) return protocolFailure(operation, `expected one response line, received ${lines.length}`)

  let parsed: unknown
  try {
    parsed = JSON.parse(lines[0])
  } catch {
    return protocolFailure(operation, 'response is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object') return protocolFailure(operation, 'response is not an object')
  const response = parsed as Partial<LocalHostResponse>
  if (response.protocol_version !== LOCAL_HOST_PROTOCOL_VERSION || response.call_id !== callId || response.ok !== true) {
    return protocolFailure(operation, 'response version, call id, or status does not match the request')
  }
  if (response.result === undefined || typeof response.result.output !== 'string' || typeof response.result.isError !== 'boolean') {
    return protocolFailure(operation, 'response result has an invalid shape')
  }
  if (response.result.images !== undefined && !Array.isArray(response.result.images)) {
    return protocolFailure(operation, 'response images has an invalid shape')
  }
  if (operation === 'read' && response.effect !== undefined && !isReadObservation(response.effect)) {
    return protocolFailure(operation, 'read observation has an invalid shape')
  }
  if (operation !== 'read' && response.effect !== undefined) return protocolFailure(operation, 'unexpected operation effect')

  return {
    result: response.result,
    ...(isReadObservation(response.effect) ? { effect: response.effect } : {}),
  }
}

/** Parent-side helper boundary. Permission/hooks/tracing remain outside this class. */
export class LocalHostToolExecutor {
  constructor(private readonly getHelperLaunch: () => ReturnType<typeof helperLaunch> = helperLaunch) {}

  async execute(
    operation: LocalHostOperation,
    input: Record<string, unknown>,
    cwd: string,
    context: ToolCallContext,
  ): Promise<LocalHostExecution> {
    const callId = randomUUID()
    let launch: { readonly argv: readonly [string, ...string[]]; readonly env?: Record<string, string> }
    try {
      launch = this.getHelperLaunch()
    } catch (error) {
      return uncertainFailure(operation, error instanceof Error ? error.message : String(error))
    }

    const request = JSON.stringify({
      protocol_version: LOCAL_HOST_PROTOCOL_VERSION,
      call_id: callId,
      operation,
      input,
      context: { cwd, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
    }) + '\n'
    const outcome = await runHostProcess({
      argv: launch.argv,
      cwd,
      ...(launch.env ? { env: launch.env } : {}),
      stdin: request,
      abortSignal: context.abortSignal,
      limits: {
        timeoutMs: operation === 'grep' || operation === 'glob' ? 70_000 : 130_000,
        stdoutBytes: HELPER_STDOUT_LIMIT,
        stderrBytes: HELPER_STDERR_LIMIT,
      },
    })

    if (outcome.kind !== 'exit' || outcome.exitCode !== 0) {
      const detail = outcome.kind === 'exit'
        ? `helper exited with code ${outcome.exitCode ?? 'null'}${outcome.signal ? ` (${outcome.signal})` : ''}`
        : outcome.kind
      if (outcome.stderr) console.error(`[local-host-tool] ${operation} ${callId}: ${detail}: ${outcome.stderr}`)
      return uncertainFailure(operation, detail)
    }
    return parseResponse(outcome.stdout, callId, operation)
  }
}

export const localHostToolExecutor = new LocalHostToolExecutor()
