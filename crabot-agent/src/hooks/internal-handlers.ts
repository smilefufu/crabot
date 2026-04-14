import type { InternalHandler, FormattedDiagnostic } from './types'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

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

  const filePath = extractFilePath(input.toolInput)
  if (!filePath) {
    return { action: 'continue' }
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8')
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

  try {
    execSync(detected.command, { cwd, timeout: 55_000, stdio: 'pipe' })
    return { action: 'continue' }
  } catch (error: unknown) {
    const stderr = error instanceof Error && 'stderr' in error
      ? String((error as { stderr: unknown }).stderr)
      : String(error)
    return {
      action: 'block',
      message: `Compile check failed (${detected.type}):\n${stderr.slice(0, 2000)}`,
    }
  }
})

// --- Helpers ---

function extractFilePath(toolInput?: Record<string, unknown>): string | undefined {
  if (!toolInput) return undefined
  const fp = toolInput.file_path ?? toolInput.filePath ?? toolInput.path
  return typeof fp === 'string' ? fp : undefined
}

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
