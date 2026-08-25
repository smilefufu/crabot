import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { LocalHostToolExecutor } from '../../src/engine/local-host-tool-executor'

describe('LocalHostToolExecutor', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-host-executor-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  async function fixture(source: string): Promise<LocalHostToolExecutor> {
    const filePath = path.join(tempDir, `fixture-${Math.random().toString(16).slice(2)}.cjs`)
    await fs.writeFile(filePath, source)
    return new LocalHostToolExecutor(() => ({ argv: [process.execPath, filePath] }))
  }

  it('runs the actual local helper and accepts its verified response', async () => {
    const filePath = path.join(tempDir, 'written.txt')
    const execution = await new LocalHostToolExecutor().execute('write', {
      file_path: filePath,
      content: 'written by helper',
    }, tempDir, {})

    expect(execution.result).toMatchObject({ isError: false })
    expect(await fs.readFile(filePath, 'utf8')).toBe('written by helper')
  })

  it.each([
    ['invalid JSON', "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('not json\\n'))"],
    ['empty stdout', "process.stdin.resume()"],
    ['multiple responses', "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{}\\n{}\\n'))"],
  ])('rejects a real helper process with %s', async (_name, source) => {
    const executor = await fixture(source)
    const execution = await executor.execute('read', { file_path: path.join(tempDir, 'missing.txt') }, tempDir, {})

    expect(execution.result.isError).toBe(true)
    expect(execution.result.output).toContain('Local tool helper protocol error')
  })

  it.each([
    ['write', { content: 'requested value' }],
    ['edit', { old_string: 'old', new_string: 'new', replace_all: false }],
  ] as const)('marks %s result unknown when a launched helper commits but cannot return a response', async (operation, input) => {
    const executor = await fixture([
      "let body = ''",
      "process.stdin.on('data', (chunk) => { body += chunk })",
      "process.stdin.on('end', () => {",
      '  const request = JSON.parse(body)',
      "  require('node:fs').writeFileSync(request.input.file_path, 'committed')",
      '})',
    ].join('\n'))
    const filePath = path.join(tempDir, 'unknown-result.txt')

    const execution = await executor.execute(operation, { file_path: filePath, ...input }, tempDir, {})

    expect(execution.result).toMatchObject({ isError: true })
    expect(execution.result.output).toContain(`Local tool execution result is unknown (${operation})`)
    expect(await fs.readFile(filePath, 'utf8')).toBe('committed')
  })
})
