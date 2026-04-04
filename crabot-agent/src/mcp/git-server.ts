/**
 * Git MCP Server — structured git CLI wrapper
 *
 * Provides 6 tools: git_status, git_diff, git_log, git_commit, git_branch, git_stash
 * All tools use child_process.execFile for safe argument handling.
 */

import { createMcpServer, type McpServer } from './mcp-helpers.js'
import { z } from 'zod/v4'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// ============================================================================
// Helper: run git command
// ============================================================================

interface GitExecResult {
  stdout: string
  stderr: string
}

async function runGit(
  args: string[],
  cwd: string,
): Promise<GitExecResult> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string }
    if (execErr.stdout !== undefined) {
      return { stdout: execErr.stdout, stderr: execErr.stderr ?? '' }
    }
    throw new Error(`git ${args[0]} failed: ${execErr.message ?? String(err)}`)
  }
}

// ============================================================================
// Helper: JSON text response
// ============================================================================

function jsonResponse(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  }
}

// ============================================================================
// Parse porcelain v1 output
// ============================================================================

interface StatusChange {
  status: string
  path: string
}

function parsePorcelainV1(output: string): StatusChange[] {
  if (!output.trim()) return []

  return output
    .trim()
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => ({
      status: line.substring(0, 2).trim(),
      path: line.substring(3),
    }))
}

// ============================================================================
// MCP Server Creation
// ============================================================================

export function createGitServer(cwd: string): McpServer {
  const server = createMcpServer({ name: 'git', version: '1.0.0' })

  // ================================================================
  // 1. git_status
  // ================================================================
  server.tool(
    'git_status',
    'Get the current git status including branch name and file changes.',
    {
      cwd: z.string().optional().describe('Working directory (default: server cwd)'),
    },
    async (args) => {
      const dir = args.cwd ?? cwd

      const [statusResult, branchResult] = await Promise.all([
        runGit(['status', '--porcelain=v1'], dir),
        runGit(['branch', '--show-current'], dir),
      ])

      const changes = parsePorcelainV1(statusResult.stdout)
      const branch = branchResult.stdout.trim()

      return jsonResponse({
        branch,
        changes,
        clean: changes.length === 0,
      })
    },
  )

  // ================================================================
  // 2. git_diff
  // ================================================================
  server.tool(
    'git_diff',
    'Show git diff output. Supports staged changes and filtering by file path.',
    {
      cwd: z.string().optional().describe('Working directory (default: server cwd)'),
      staged: z.boolean().optional().describe('Show staged changes (--staged)'),
      file_path: z.string().optional().describe('Limit diff to a specific file'),
    },
    async (args) => {
      const dir = args.cwd ?? cwd
      const gitArgs = ['diff']
      if (args.staged) gitArgs.push('--staged')
      if (args.file_path) {
        gitArgs.push('--')
        gitArgs.push(args.file_path)
      }

      const result = await runGit(gitArgs, dir)
      return jsonResponse({ diff: result.stdout })
    },
  )

  // ================================================================
  // 3. git_log
  // ================================================================
  server.tool(
    'git_log',
    'Show git log with oneline format.',
    {
      cwd: z.string().optional().describe('Working directory (default: server cwd)'),
      count: z.number().optional().describe('Number of commits to show (default: 20)'),
      format: z.string().optional().describe('Custom format string'),
    },
    async (args) => {
      const dir = args.cwd ?? cwd
      const count = args.count ?? 20
      const gitArgs = ['log', '--oneline', `-n`, `${count}`]

      const result = await runGit(gitArgs, dir)
      return jsonResponse({ log: result.stdout.trim() })
    },
  )

  // ================================================================
  // 4. git_commit
  // ================================================================
  server.tool(
    'git_commit',
    'Create a git commit. Optionally stage files first.',
    {
      cwd: z.string().optional().describe('Working directory (default: server cwd)'),
      message: z.string().describe('Commit message'),
      files: z.array(z.string()).optional().describe('Files to stage before committing'),
    },
    async (args) => {
      const dir = args.cwd ?? cwd

      // Stage files if provided
      if (args.files && args.files.length > 0) {
        await runGit(['add', ...args.files], dir)
      }

      // Commit
      const commitResult = await runGit(['commit', '-m', args.message], dir)

      // Extract commit hash
      const hashResult = await runGit(['rev-parse', '--short', 'HEAD'], dir)
      const hash = hashResult.stdout.trim()

      return jsonResponse({
        hash,
        message: args.message,
        output: commitResult.stdout.trim(),
      })
    },
  )

  // ================================================================
  // 5. git_branch
  // ================================================================
  server.tool(
    'git_branch',
    'Manage git branches: list, create, delete, or checkout.',
    {
      cwd: z.string().optional().describe('Working directory (default: server cwd)'),
      action: z.enum(['list', 'create', 'delete', 'checkout']).describe('Branch action'),
      name: z.string().optional().describe('Branch name (required for create/delete/checkout)'),
    },
    async (args) => {
      const dir = args.cwd ?? cwd

      switch (args.action) {
        case 'list': {
          const result = await runGit(['branch', '-a'], dir)
          return jsonResponse({ output: result.stdout.trim() })
        }
        case 'create': {
          if (!args.name) {
            return jsonResponse({ error: 'Branch name is required for create action' })
          }
          const result = await runGit(['checkout', '-b', args.name], dir)
          return jsonResponse({ output: result.stderr.trim() || result.stdout.trim() })
        }
        case 'delete': {
          if (!args.name) {
            return jsonResponse({ error: 'Branch name is required for delete action' })
          }
          const result = await runGit(['branch', '-d', args.name], dir)
          return jsonResponse({ output: result.stdout.trim() })
        }
        case 'checkout': {
          if (!args.name) {
            return jsonResponse({ error: 'Branch name is required for checkout action' })
          }
          const result = await runGit(['checkout', args.name], dir)
          return jsonResponse({ output: result.stderr.trim() || result.stdout.trim() })
        }
      }
    },
  )

  // ================================================================
  // 6. git_stash
  // ================================================================
  server.tool(
    'git_stash',
    'Manage git stash: push, pop, or list stashed changes.',
    {
      cwd: z.string().optional().describe('Working directory (default: server cwd)'),
      action: z.enum(['push', 'pop', 'list']).describe('Stash action'),
      message: z.string().optional().describe('Stash message (for push action)'),
    },
    async (args) => {
      const dir = args.cwd ?? cwd

      switch (args.action) {
        case 'push': {
          const gitArgs = ['stash', 'push']
          if (args.message) {
            gitArgs.push('-m', args.message)
          }
          const result = await runGit(gitArgs, dir)
          return jsonResponse({ output: result.stdout.trim() })
        }
        case 'pop': {
          const result = await runGit(['stash', 'pop'], dir)
          return jsonResponse({ output: result.stdout.trim() })
        }
        case 'list': {
          const result = await runGit(['stash', 'list'], dir)
          return jsonResponse({ output: result.stdout.trim() })
        }
      }
    },
  )

  return server
}
