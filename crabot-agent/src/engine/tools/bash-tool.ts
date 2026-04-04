import { execFile } from 'child_process'
import { defineTool } from '../tool-framework'
import type { ToolDefinition, ToolCallContext, ToolCallResult } from '../types'

const MAX_OUTPUT_LENGTH = 100000
const DEFAULT_TIMEOUT_MS = 120000

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) {
    return output
  }
  const halfLimit = Math.floor((MAX_OUTPUT_LENGTH - 20) / 2)
  return `${output.slice(0, halfLimit)}\n[...truncated...]\n${output.slice(-halfLimit)}`
}

function execCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ToolCallResult> {
  return new Promise((resolve) => {
    const child = execFile(
      '/bin/sh',
      ['-c', command],
      { cwd, timeout: timeoutMs, signal, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const stderrTrimmed = stderr.trim()
        const stdoutTrimmed = stdout ?? ''

        if (error !== null) {
          // Timeout
          if (error.killed && (error as NodeJS.ErrnoException).code === undefined) {
            resolve({
              output: `Command timed out after ${timeoutMs}ms`,
              isError: true,
            })
            return
          }

          // Abort
          if (error.name === 'AbortError' || signal?.aborted === true) {
            resolve({
              output: 'Command aborted',
              isError: true,
            })
            return
          }

          // Command failure
          const parts: string[] = []
          if (error.message) {
            parts.push(error.message)
          }
          if (stdoutTrimmed) {
            parts.push(stdoutTrimmed)
          }
          if (stderrTrimmed) {
            parts.push(`stderr: ${stderrTrimmed}`)
          }
          resolve({
            output: truncateOutput(parts.join('\n') || 'Command failed'),
            isError: true,
          })
          return
        }

        // Success
        const outputParts: string[] = [stdoutTrimmed]
        if (stderrTrimmed) {
          outputParts.push(`stderr: ${stderrTrimmed}`)
        }
        resolve({
          output: truncateOutput(outputParts.join('\n')),
          isError: false,
        })
      },
    )

    // If signal is already aborted, kill the child
    if (signal?.aborted === true) {
      child.kill()
    }
  })
}

export function createBashTool(cwd: string, defaultTimeout?: number): ToolDefinition {
  const effectiveDefault = defaultTimeout ?? DEFAULT_TIMEOUT_MS
  return defineTool({
    name: 'Bash',
    description: 'Executes a bash command in the working directory and returns its output.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: { type: 'number', description: `Timeout in milliseconds (default ${effectiveDefault})` },
      },
      required: ['command'],
    },
    isReadOnly: false,
    permissionLevel: 'dangerous',
    call: async (input: Record<string, unknown>, context: ToolCallContext): Promise<ToolCallResult> => {
      const command = input.command as string
      const timeoutMs = typeof input.timeout === 'number' ? input.timeout : effectiveDefault

      return execCommand(command, cwd, timeoutMs, context.abortSignal)
    },
  })
}
