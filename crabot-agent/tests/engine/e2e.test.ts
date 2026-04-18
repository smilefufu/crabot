import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { runEngine } from '../../src/engine/query-loop'
import { getAllBuiltinTools } from '../../src/engine/tools/index'
import type { LLMAdapter, LLMStreamParams } from '../../src/engine/llm-adapter'
import type {
  EngineOptions,
  StreamChunk,
  ToolDefinition,
} from '../../src/engine/types'

// ---------------------------------------------------------------------------
// Mock LLM Adapter
// ---------------------------------------------------------------------------

interface ScriptEntry {
  readonly text?: string
  readonly toolCalls?: ReadonlyArray<{
    readonly name: string
    readonly input: Record<string, unknown>
  }>
  /** Optional delay in ms before yielding chunks (for abort tests) */
  readonly delay?: number
}

/**
 * Creates a mock LLM adapter that replays a pre-scripted sequence of responses.
 * Each call to `stream()` consumes the next entry in the script.
 * If toolCalls are present, stop_reason is 'tool_use'; otherwise 'end_turn'.
 */
function createScriptedAdapter(
  script: ReadonlyArray<ScriptEntry>,
): LLMAdapter {
  let callIndex = 0

  return {
    async *stream(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
      const entry = script[callIndex] ?? { text: '[script exhausted]' }
      callIndex++

      if (entry.delay !== undefined && entry.delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, entry.delay))
      }

      // Check abort before yielding
      if (params.signal?.aborted) {
        return
      }

      const messageId = `msg_${randomUUID().slice(0, 8)}`
      yield { type: 'message_start', messageId }

      // Yield text
      const text = entry.text ?? ''
      if (text.length > 0) {
        yield { type: 'text_delta', text }
      }

      // Yield tool calls
      const hasToolCalls =
        entry.toolCalls !== undefined && entry.toolCalls.length > 0
      if (hasToolCalls) {
        for (const tc of entry.toolCalls!) {
          const toolId = `toolu_${randomUUID().slice(0, 12)}`
          yield { type: 'tool_use_start', id: toolId, name: tc.name }
          yield {
            type: 'tool_use_delta',
            id: toolId,
            inputJson: JSON.stringify(tc.input),
          }
          yield { type: 'tool_use_end', id: toolId }
        }
      }

      const stopReason = hasToolCalls ? 'tool_use' : 'end_turn'
      yield {
        type: 'message_end',
        stopReason,
        usage: { inputTokens: 100, outputTokens: 50 },
      }
    },

    updateConfig() {
      // no-op for mock
    },
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'crabot-e2e-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function baseOptions(
  tools: ReadonlyArray<ToolDefinition>,
  overrides?: Partial<EngineOptions>,
): EngineOptions {
  return {
    systemPrompt: 'You are a test assistant.',
    tools: [...tools],
    model: 'test-model',
    maxTurns: 20,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test Scenarios
// ---------------------------------------------------------------------------

describe('Engine E2E', () => {
  // -----------------------------------------------------------------------
  // 1. Multi-step file operation task
  // -----------------------------------------------------------------------
  describe('multi-step file operations', () => {
    it('should write, read, and edit a file across multiple turns', async () => {
      const targetPath = join(tempDir, 'hello.txt')
      const tools = getAllBuiltinTools(tempDir)

      const adapter = createScriptedAdapter([
        // Turn 1: Write a file
        {
          text: 'Creating file...',
          toolCalls: [
            {
              name: 'Write',
              input: {
                file_path: targetPath,
                content: 'Hello, World!',
              },
            },
          ],
        },
        // Turn 2: Read the file back
        {
          text: 'Reading file...',
          toolCalls: [
            {
              name: 'Read',
              input: { file_path: targetPath },
            },
          ],
        },
        // Turn 3: Edit the file
        {
          text: 'Editing file...',
          toolCalls: [
            {
              name: 'Edit',
              input: {
                file_path: targetPath,
                old_string: 'Hello, World!',
                new_string: 'Hello, Crabot!',
              },
            },
          ],
        },
        // Turn 4: Final text (no tool calls)
        {
          text: 'File operations complete. The file now contains "Hello, Crabot!".',
        },
      ])

      const result = await runEngine({
        prompt: 'Create and modify a file.',
        adapter,
        options: baseOptions(tools),
      })

      expect(result.outcome).toBe('completed')
      expect(result.totalTurns).toBe(4)

      // Verify the file actually exists with correct content
      const content = await readFile(targetPath, 'utf-8')
      expect(content).toBe('Hello, Crabot!')
    })
  })

  // -----------------------------------------------------------------------
  // 2. Search and analysis task
  // -----------------------------------------------------------------------
  describe('search and analysis task', () => {
    it('should use Glob and Grep to find and search files', async () => {
      // Set up test files
      const subDir = join(tempDir, 'src')
      await mkdir(subDir, { recursive: true })
      await writeFile(join(subDir, 'main.ts'), 'export function hello() { return "hi" }')
      await writeFile(join(subDir, 'utils.ts'), 'export function greet(name: string) { return `Hello ${name}` }')

      const tools = getAllBuiltinTools(tempDir)

      const adapter = createScriptedAdapter([
        // Turn 1: Glob for .ts files
        {
          text: 'Searching for TypeScript files...',
          toolCalls: [
            {
              name: 'Glob',
              input: { pattern: '**/*.ts' },
            },
          ],
        },
        // Turn 2: Grep for "function"
        {
          text: 'Searching for functions...',
          toolCalls: [
            {
              name: 'Grep',
              input: { pattern: 'function', path: tempDir },
            },
          ],
        },
        // Turn 3: Return analysis
        {
          text: 'Found 2 TypeScript files with 2 function declarations.',
        },
      ])

      const result = await runEngine({
        prompt: 'Find and analyze TypeScript files.',
        adapter,
        options: baseOptions(tools),
      })

      expect(result.outcome).toBe('completed')
      expect(result.totalTurns).toBe(3)
      expect(result.finalText).toContain('Found 2 TypeScript files')
    })
  })

  // -----------------------------------------------------------------------
  // 3. Permission system integration
  // -----------------------------------------------------------------------
  describe('permission system integration', () => {
    it('should deny Bash but allow Read in allowList mode', async () => {
      // Create a readable file
      const filePath = join(tempDir, 'readable.txt')
      await writeFile(filePath, 'permitted content')

      const tools = getAllBuiltinTools(tempDir)

      const turnEvents: Array<{ toolCalls: ReadonlyArray<{ name: string }> }> = []

      const adapter = createScriptedAdapter([
        // Turn 1: Try Bash (should be denied)
        {
          text: 'Trying bash...',
          toolCalls: [
            {
              name: 'Bash',
              input: { command: 'echo "should not run"' },
            },
          ],
        },
        // Turn 2: Try Read (should work)
        {
          text: 'Reading file...',
          toolCalls: [
            {
              name: 'Read',
              input: { file_path: filePath },
            },
          ],
        },
        // Turn 3: Done
        {
          text: 'Bash was denied, Read worked.',
        },
      ])

      const result = await runEngine({
        prompt: 'Try bash then read.',
        adapter,
        options: baseOptions(tools, {
          permissionConfig: {
            mode: 'allowList',
            toolNames: ['Read', 'Glob'],
          },
          onTurn: (event) => {
            turnEvents.push({ toolCalls: event.toolCalls })
          },
        }),
      })

      expect(result.outcome).toBe('completed')
      expect(result.totalTurns).toBe(3)

      // Verify tool calls were tracked
      expect(turnEvents).toHaveLength(2)
      expect(turnEvents[0].toolCalls[0].name).toBe('Bash')
      expect(turnEvents[1].toolCalls[0].name).toBe('Read')
    })
  })

  // -----------------------------------------------------------------------
  // 4. maxTurns enforcement
  // -----------------------------------------------------------------------
  describe('maxTurns enforcement', () => {
    it('should stop with max_turns outcome when limit is reached', async () => {
      const tools = getAllBuiltinTools(tempDir)

      // Script that always calls a tool (never ends naturally)
      const infiniteScript: ScriptEntry[] = Array.from(
        { length: 10 },
        () => ({
          text: 'Working...',
          toolCalls: [
            {
              name: 'Glob',
              input: { pattern: '*' },
            },
          ],
        }),
      )

      const adapter = createScriptedAdapter(infiniteScript)

      const result = await runEngine({
        prompt: 'Keep working forever.',
        adapter,
        options: baseOptions(tools, { maxTurns: 3 }),
      })

      expect(result.outcome).toBe('max_turns')
      expect(result.totalTurns).toBe(3)
    })
  })

  // -----------------------------------------------------------------------
  // 5. Abort signal
  // -----------------------------------------------------------------------
  describe('abort signal', () => {
    it('should stop with aborted outcome when signal is already aborted', async () => {
      const tools = getAllBuiltinTools(tempDir)

      const controller = new AbortController()
      // Pre-abort so the engine sees it immediately at the top of the loop
      controller.abort()

      const adapter = createScriptedAdapter([
        { text: 'Should never reach here.' },
      ])

      const result = await runEngine({
        prompt: 'Do stuff.',
        adapter,
        options: baseOptions(tools, { abortSignal: controller.signal }),
      })

      expect(result.outcome).toBe('aborted')
      expect(result.totalTurns).toBe(0)
    })

    it('should abort mid-stream when signal fires during chunk iteration', async () => {
      const tools = getAllBuiltinTools(tempDir)

      const controller = new AbortController()

      // Custom adapter that aborts the signal after yielding the first text chunk
      // on the second call. The for-await loop checks abortSignal after each chunk.
      let callIndex = 0
      const customAdapter: LLMAdapter = {
        async *stream(_params: LLMStreamParams): AsyncGenerator<StreamChunk> {
          callIndex++

          yield { type: 'message_start', messageId: `msg_${callIndex}` }

          if (callIndex === 1) {
            yield { type: 'text_delta', text: 'Turn 1' }
            const toolId = `toolu_${randomUUID().slice(0, 12)}`
            yield { type: 'tool_use_start', id: toolId, name: 'Glob' }
            yield { type: 'tool_use_delta', id: toolId, inputJson: '{"pattern":"*"}' }
            yield { type: 'tool_use_end', id: toolId }
            yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } }
          } else {
            // Yield first text chunk, then abort before yielding more
            yield { type: 'text_delta', text: 'Turn 2 start' }
            // Abort synchronously - the engine checks abortSignal after processing each chunk
            controller.abort()
            // These should not be processed
            yield { type: 'text_delta', text: ' - should be ignored' }
            yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } }
          }
        },
        updateConfig() {},
      }

      const result = await runEngine({
        prompt: 'Do stuff.',
        adapter: customAdapter,
        options: baseOptions(tools, { abortSignal: controller.signal }),
      })

      expect(result.outcome).toBe('aborted')
      // First turn completed, second was aborted mid-stream
      expect(result.totalTurns).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // 6. Skill tool integration
  // -----------------------------------------------------------------------
  describe('skill tool integration', () => {
    it('should load a skill from the skills directory', async () => {
      // Set up a skill directory structure:
      // <tempDir>/.claude/skills/test-skill/SKILL.md
      const skillDir = join(tempDir, '.claude', 'skills', 'test-skill')
      await mkdir(skillDir, { recursive: true })
      await writeFile(
        join(skillDir, 'SKILL.md'),
        '# Test Skill\nThis is a test skill for e2e testing.',
      )

      const tools = getAllBuiltinTools(tempDir, { skillsDir: tempDir })

      const adapter = createScriptedAdapter([
        // Turn 1: Call the Skill tool
        {
          text: 'Loading skill...',
          toolCalls: [
            {
              name: 'Skill',
              input: { skill: 'test-skill' },
            },
          ],
        },
        // Turn 2: Done
        {
          text: 'Skill loaded successfully.',
        },
      ])

      const result = await runEngine({
        prompt: 'Load the test skill.',
        adapter,
        options: baseOptions(tools),
      })

      expect(result.outcome).toBe('completed')
      expect(result.totalTurns).toBe(2)
    })
  })

  // -----------------------------------------------------------------------
  // 7. Text-only response (no tools)
  // -----------------------------------------------------------------------
  describe('simple text response', () => {
    it('should complete in one turn with no tool calls', async () => {
      const tools = getAllBuiltinTools(tempDir)

      const adapter = createScriptedAdapter([
        { text: 'The answer is 42.' },
      ])

      const result = await runEngine({
        prompt: 'What is the meaning of life?',
        adapter,
        options: baseOptions(tools),
      })

      expect(result.outcome).toBe('completed')
      expect(result.totalTurns).toBe(1)
      expect(result.finalText).toBe('The answer is 42.')
      expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0)
      expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0)
    })
  })

  // -----------------------------------------------------------------------
  // 8. onTurn callback
  // -----------------------------------------------------------------------
  describe('callbacks', () => {
    it('should fire onTurn during execution', async () => {
      const tools = getAllBuiltinTools(tempDir)
      const turnEvents: number[] = []

      const adapter = createScriptedAdapter([
        {
          text: 'Step one.',
          toolCalls: [
            { name: 'Glob', input: { pattern: '*' } },
          ],
        },
        { text: 'Done.' },
      ])

      const result = await runEngine({
        prompt: 'Test callbacks.',
        adapter,
        options: baseOptions(tools, {
          onTurn: (event) => {
            turnEvents.push(event.turnNumber)
          },
        }),
      })

      expect(result.outcome).toBe('completed')
      expect(result.totalTurns).toBe(2)

      // onTurn fires only for turns with tool calls (before executing them)
      expect(turnEvents).toContain(1)
    })
  })

  // -----------------------------------------------------------------------
  // 9. Bash tool with real command execution
  // -----------------------------------------------------------------------
  describe('bash tool integration', () => {
    it('should execute bash commands in the correct cwd', async () => {
      const tools = getAllBuiltinTools(tempDir)

      const adapter = createScriptedAdapter([
        {
          text: 'Running command...',
          toolCalls: [
            {
              name: 'Bash',
              input: { command: 'echo "test-output" > output.txt && cat output.txt' },
            },
          ],
        },
        {
          text: 'Command executed successfully.',
        },
      ])

      const result = await runEngine({
        prompt: 'Run a bash command.',
        adapter,
        options: baseOptions(tools, {
          permissionConfig: { mode: 'bypass' },
        }),
      })

      expect(result.outcome).toBe('completed')
      expect(result.totalTurns).toBe(2)

      // Verify the file was created in tempDir (cwd for bash)
      const content = await readFile(join(tempDir, 'output.txt'), 'utf-8')
      expect(content.trim()).toBe('test-output')
    })
  })
})
