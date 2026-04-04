/**
 * Tests for Git MCP Server
 *
 * Uses a real temporary git repo for integration testing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createGitServer } from '../../src/mcp/git-server.js'

// ============================================================================
// Helper: call a tool on the MCP server
// ============================================================================

async function callTool(
  server: ReturnType<typeof createGitServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // McpServer stores tools as plain object: _registeredTools[name].handler
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = server as any
  const registeredTools = s._registeredTools as Record<string, { handler: Function }>
  const tool = registeredTools[toolName]
  if (!tool) {
    throw new Error(`Tool "${toolName}" not found. Available: ${
      Object.keys(registeredTools).join(', ')
    }`)
  }
  const result = await tool.handler(args, {})
  // Extract text content
  const textContent = result.content?.find((c: { type: string }) => c.type === 'text')
  return textContent ? JSON.parse(textContent.text) : result
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Git MCP Server', () => {
  let tmpDir: string
  let server: ReturnType<typeof createGitServer>

  beforeAll(() => {
    // Create a temp directory with a real git repo
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-mcp-test-'))

    // Initialize git repo
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: tmpDir, encoding: 'utf-8' })

    git(['init'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test User'])

    // Create initial commit
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test Repo\n')
    git(['add', 'README.md'])
    git(['commit', '-m', 'Initial commit'])

    server = createGitServer(tmpDir)
  })

  afterAll(() => {
    // Cleanup temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ==========================================================================
  // 1. Server has expected tool names
  // ==========================================================================

  it('should register 6 tools', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = server as any
    const toolNames = Object.keys(s._registeredTools)
    expect(toolNames).toHaveLength(6)
    expect(toolNames).toContain('git_status')
    expect(toolNames).toContain('git_diff')
    expect(toolNames).toContain('git_log')
    expect(toolNames).toContain('git_commit')
    expect(toolNames).toContain('git_branch')
    expect(toolNames).toContain('git_stash')
  })

  // ==========================================================================
  // 2. git_status on clean repo
  // ==========================================================================

  it('git_status returns clean status on fresh repo', async () => {
    const result = await callTool(server, 'git_status', {}) as {
      branch: string
      changes: Array<{ status: string; path: string }>
      clean: boolean
    }

    expect(result.clean).toBe(true)
    expect(result.changes).toEqual([])
    expect(typeof result.branch).toBe('string')
  })

  // ==========================================================================
  // 3. git_status with modified file
  // ==========================================================================

  it('git_status detects modified files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'new-file.txt'), 'hello\n')

    const result = await callTool(server, 'git_status', {}) as {
      branch: string
      changes: Array<{ status: string; path: string }>
      clean: boolean
    }

    expect(result.clean).toBe(false)
    expect(result.changes.length).toBeGreaterThan(0)
    expect(result.changes.some(c => c.path === 'new-file.txt')).toBe(true)

    // Cleanup: remove the file
    fs.unlinkSync(path.join(tmpDir, 'new-file.txt'))
  })

  // ==========================================================================
  // 4. git_diff shows changes
  // ==========================================================================

  it('git_diff shows unstaged changes', async () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test Repo\n\nUpdated.\n')

    const result = await callTool(server, 'git_diff', {}) as { diff: string }

    expect(result.diff).toContain('Updated.')

    // Restore
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test Repo\n')
  })

  it('git_diff shows staged changes', async () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test Repo\n\nStaged change.\n')
    execFileSync('git', ['add', 'README.md'], { cwd: tmpDir })

    const result = await callTool(server, 'git_diff', { staged: true }) as { diff: string }

    expect(result.diff).toContain('Staged change.')

    // Reset
    execFileSync('git', ['reset', 'HEAD', 'README.md'], { cwd: tmpDir })
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test Repo\n')
  })

  // ==========================================================================
  // 5. git_log shows commits
  // ==========================================================================

  it('git_log shows commits', async () => {
    const result = await callTool(server, 'git_log', { count: 5 }) as { log: string }

    expect(result.log).toContain('Initial commit')
  })

  // ==========================================================================
  // 6. git_commit creates a commit
  // ==========================================================================

  it('git_commit creates a new commit', async () => {
    fs.writeFileSync(path.join(tmpDir, 'committed.txt'), 'committed content\n')

    const result = await callTool(server, 'git_commit', {
      message: 'Add committed.txt',
      files: ['committed.txt'],
    }) as { hash: string; message: string }

    expect(result.hash).toBeTruthy()
    expect(result.message).toContain('Add committed.txt')

    // Verify the commit exists in log
    const logResult = await callTool(server, 'git_log', { count: 1 }) as { log: string }
    expect(logResult.log).toContain('Add committed.txt')
  })

  // ==========================================================================
  // 7. git_branch list/create/checkout
  // ==========================================================================

  it('git_branch list shows branches', async () => {
    const result = await callTool(server, 'git_branch', { action: 'list' }) as { output: string }

    expect(result.output).toBeTruthy()
  })

  it('git_branch create and checkout', async () => {
    // Create
    const createResult = await callTool(server, 'git_branch', {
      action: 'create',
      name: 'test-branch',
    }) as { output: string }
    expect(createResult.output).toBeTruthy()

    // Verify we're on the new branch
    const statusResult = await callTool(server, 'git_status', {}) as { branch: string }
    expect(statusResult.branch).toBe('test-branch')

    // Checkout back to main/master
    const mainBranch = execFileSync('git', ['branch', '--list', 'main'], {
      cwd: tmpDir, encoding: 'utf-8',
    }).trim() ? 'main' : 'master'

    await callTool(server, 'git_branch', { action: 'checkout', name: mainBranch })
    const afterCheckout = await callTool(server, 'git_status', {}) as { branch: string }
    expect(afterCheckout.branch).toBe(mainBranch)

    // Delete
    await callTool(server, 'git_branch', { action: 'delete', name: 'test-branch' })
  })

  // ==========================================================================
  // 8. git_stash push/pop/list
  // ==========================================================================

  it('git_stash push/list/pop', async () => {
    // Create a change to stash
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test Repo\n\nStash me.\n')

    // Push
    const pushResult = await callTool(server, 'git_stash', {
      action: 'push',
      message: 'test stash',
    }) as { output: string }
    expect(pushResult.output).toBeTruthy()

    // Verify file is reverted
    const content = fs.readFileSync(path.join(tmpDir, 'README.md'), 'utf-8')
    expect(content).toBe('# Test Repo\n')

    // List
    const listResult = await callTool(server, 'git_stash', { action: 'list' }) as { output: string }
    expect(listResult.output).toContain('test stash')

    // Pop
    const popResult = await callTool(server, 'git_stash', { action: 'pop' }) as { output: string }
    expect(popResult.output).toBeTruthy()

    // Verify file is restored
    const restored = fs.readFileSync(path.join(tmpDir, 'README.md'), 'utf-8')
    expect(restored).toContain('Stash me.')

    // Cleanup
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test Repo\n')
    execFileSync('git', ['checkout', '--', 'README.md'], { cwd: tmpDir })
  })
})
