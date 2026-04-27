import type { InternalHandler, FormattedDiagnostic } from './types'
import { extractFilePaths } from '../engine/tool-orchestration'
import { exec } from 'child_process'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import { CLI_WRITE_SUBCOMMANDS } from 'crabot-shared'
import { parseCrabotInvocation } from './crabot-cmd-parser.js'

const handlers = new Map<string, InternalHandler>()

export function registerInternalHandler(name: string, handler: InternalHandler): void {
  handlers.set(name, handler)
}

export function getInternalHandler(name: string): InternalHandler | undefined {
  return handlers.get(name)
}

// --- Built-in: lsp-diagnostics ---

registerInternalHandler('lsp-diagnostics', async (input, context) => {
  if (!context.lspManager) {
    return { action: 'continue' }
  }

  const filePath = input.toolInput ? extractFilePaths(input.toolInput)[0] : undefined
  if (!filePath) {
    return { action: 'continue' }
  }

  try {
    const content = await fsp.readFile(filePath, 'utf-8')
    context.lspManager.notifyFileChanged(filePath, content)
    const diagnostics = await context.lspManager.getDiagnostics(filePath)

    if (diagnostics.length === 0) {
      return { action: 'continue' }
    }

    const message = formatDiagnosticsMessage(diagnostics)
    const hasErrors = diagnostics.some((d) => d.severity === 'error')

    return {
      action: hasErrors ? 'block' : 'continue',
      message,
    }
  } catch {
    return { action: 'continue' }
  }
})

// --- Built-in: compile-check ---

registerInternalHandler('compile-check', async (_input, context) => {
  const cwd = context.workingDirectory
  const detected = detectProjectType(cwd)

  if (!detected) {
    return { action: 'continue' }
  }

  return new Promise((resolve) => {
    const child = exec(detected.command, { cwd, timeout: 55_000 }, (error, _stdout, stderr) => {
      if (error) {
        resolve({
          action: 'block',
          message: `Compile check failed (${detected.type}):\n${(stderr || error.message).slice(0, 2000)}`,
        })
      } else {
        resolve({ action: 'continue' })
      }
    })
    child.stdin?.end()
  })
})

// --- Built-in: block-cli-write ---
// 解析 Bash 命令中的 crabot 调用，拦截 write 类子命令和 --reveal
registerInternalHandler('block-cli-write', async (input, _context) => {
  const cmdStr = String(input.toolInput?.['command'] ?? '')
  const parsed = parseCrabotInvocation(cmdStr)
  if (!parsed) return { action: 'continue' }
  if (parsed.hasReveal) {
    return { action: 'block', message: '`--reveal` 仅在 master 私聊场景可用。' }
  }
  if (CLI_WRITE_SUBCOMMANDS.has(parsed.subcommand)) {
    return { action: 'block', message: `命令 \`crabot ${parsed.subcommand}\` 仅在 master 私聊场景可用。` }
  }
  return { action: 'continue' }
})

// --- Built-in: block-cli (legacy alias) ---
registerInternalHandler('block-cli', async (input, context) => {
  const fwd = getInternalHandler('block-cli-write')
  if (!fwd) return { action: 'block', message: 'CLI 管理命令仅在 master 私聊场景可用。' }
  return fwd(input, context)
})

// --- Helpers ---

function formatDiagnosticsMessage(diagnostics: ReadonlyArray<FormattedDiagnostic>): string {
  const lines = diagnostics.map((d) =>
    `${d.filePath}:${d.line}:${d.column} [${d.severity.toUpperCase()}] ${d.message} (${d.source})`
  )
  return `LSP Diagnostics:\n${lines.join('\n')}`
}

interface ProjectType {
  readonly type: string
  readonly command: string
}

function detectProjectType(cwd: string): ProjectType | undefined {
  if (fs.existsSync(path.join(cwd, 'package.json'))) {
    return { type: 'node', command: 'npm run build --if-present 2>&1' }
  }
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    return { type: 'rust', command: 'cargo check 2>&1' }
  }
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    return { type: 'go', command: 'go build ./... 2>&1' }
  }
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'setup.py'))) {
    return { type: 'python', command: 'python -m py_compile $(find . -name "*.py" -not -path "*/venv/*" | head -20) 2>&1' }
  }
  return undefined
}
