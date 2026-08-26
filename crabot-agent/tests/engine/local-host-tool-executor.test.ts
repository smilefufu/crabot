import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { LocalHostToolExecutor } from '../../src/engine/local-host-tool-executor'

const execFileAsync = promisify(execFile)
const itPosix = process.platform === 'win32' ? it.skip : it

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

  itPosix('cleans the actual helper temporary file when an Edit is aborted', async () => {
    const pipePath = path.join(tempDir, 'blocked-input')
    await execFileAsync('mkfifo', [pipePath])
    const controller = new AbortController()
    const execution = new LocalHostToolExecutor().execute('edit', {
      file_path: pipePath,
      old_string: 'old',
      new_string: 'new',
    }, tempDir, { abortSignal: controller.signal })

    // The first pass consumes this writer. The helper then opens the FIFO for its second pass,
    // after its same-directory temporary file exists, and blocks waiting for another writer.
    await fs.writeFile(pipePath, 'old')
    const temporaryPrefix = `.${path.basename(pipePath)}.`
    const deadline = Date.now() + 5_000
    while (!(await fs.readdir(tempDir)).some((name) => name.startsWith(temporaryPrefix) && name.endsWith('.tmp'))) {
      if (Date.now() >= deadline) throw new Error('helper did not create its temporary file')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    controller.abort()
    const result = await execution

    expect(result.result.output).toContain('Local tool execution result is unknown (edit)')
    expect((await fs.readdir(tempDir)).some((name) => name.startsWith(temporaryPrefix) && name.endsWith('.tmp'))).toBe(false)
  }, 10_000)
})
