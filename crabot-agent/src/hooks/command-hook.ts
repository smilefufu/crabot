import { spawn } from 'child_process'
import type { HookDefinition, HookInput, HookResult, InternalHandlerContext } from './types'
import { getInternalHandler } from './internal-handlers'

const DEFAULT_TIMEOUT_SECONDS = 30

export async function executeCommandHook(
  hook: HookDefinition,
  input: HookInput,
  context: InternalHandlerContext,
): Promise<HookResult> {
  const command = hook.command
  if (!command) {
    return { action: 'continue' }
  }

  // Route __internal: prefix to built-in handlers
  if (command.startsWith('__internal:')) {
    const handlerName = command.slice('__internal:'.length)
    const handler = getInternalHandler(handlerName)
    if (!handler) {
      return { action: 'continue', message: `Unknown internal handler: ${handlerName}` }
    }
    return handler(input, context)
  }

  // Execute shell command
  const timeoutMs = (hook.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000
  const inputJson = JSON.stringify(input)

  return new Promise<HookResult>((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd: context.workingDirectory,
      env: {
        ...process.env,
        HOOK_EVENT: input.event,
        TOOL_NAME: input.toolName ?? '',
        WORKING_DIR: context.workingDirectory,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        resolve({ action: 'continue', message: `Hook timeout after ${hook.timeout ?? DEFAULT_TIMEOUT_SECONDS}s` })
      }
    }, timeoutMs)

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

    // Ignore EPIPE when process exits before consuming stdin
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') throw err
    })
    child.stdin.write(inputJson)
    child.stdin.end()

    child.on('error', (error) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ action: 'continue', message: `Hook error: ${error.message}` })
      }
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (code === null) {
        resolve({ action: 'continue', message: `Hook timeout after ${hook.timeout ?? DEFAULT_TIMEOUT_SECONDS}s` })
        return
      }

      // Try to parse stdout as structured JSON
      const trimmedStdout = stdout.trim()
      if (trimmedStdout.length > 0) {
        try {
          const parsed = JSON.parse(trimmedStdout)
          if (typeof parsed === 'object' && parsed !== null && 'action' in parsed) {
            resolve({
              action: parsed.action === 'block' ? 'block' : 'continue',
              message: typeof parsed.message === 'string' ? parsed.message : undefined,
              modifiedInput: typeof parsed.modifiedInput === 'object' ? parsed.modifiedInput : undefined,
            })
            return
          }
        } catch {
          // Not valid JSON, fall through
        }
      }

      // Exit code convention
      if (code === 0) {
        resolve({
          action: 'continue',
          message: trimmedStdout.length > 0 ? trimmedStdout : undefined,
        })
      } else if (code === 2) {
        resolve({
          action: 'block',
          message: stderr.trim() || trimmedStdout || 'Hook blocked execution',
        })
      } else {
        resolve({
          action: 'continue',
          message: stderr.trim() || undefined,
        })
      }
    })
  })
}
