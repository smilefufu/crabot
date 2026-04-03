import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const WORKER_HANDLER_PATH = path.resolve(
  process.cwd(),
  'src/agent/worker-handler.ts',
)

describe('WorkerHandler v2 (engine-based)', () => {
  const source = fs.readFileSync(WORKER_HANDLER_PATH, 'utf-8')

  // Extract import blocks (may span multiple lines)
  const importBlockPattern = /^import\s[\s\S]*?from\s+['"][^'"]+['"]/gm
  const importBlocks = source.match(importBlockPattern) ?? []

  it('should NOT import from @anthropic-ai/claude-agent-sdk', () => {
    const sdkImports = importBlocks.filter(block =>
      block.includes('@anthropic-ai/claude-agent-sdk'),
    )
    expect(sdkImports).toHaveLength(0)
  })

  it('should import from ../engine/', () => {
    const engineImports = importBlocks.filter(block =>
      block.includes('../engine/'),
    )
    expect(engineImports.length).toBeGreaterThanOrEqual(1)
  })

  it('should import AnthropicAdapter', () => {
    const adapterImports = importBlocks.filter(block =>
      block.includes('AnthropicAdapter'),
    )
    expect(adapterImports.length).toBeGreaterThanOrEqual(1)
  })

  it('should import runEngine', () => {
    const engineImports = importBlocks.filter(block =>
      block.includes('runEngine'),
    )
    expect(engineImports.length).toBeGreaterThanOrEqual(1)
  })

  it('should NOT reference SDK types (SDKMessage, SDKUserMessage)', () => {
    const nonCommentLines = source
      .split('\n')
      .filter(line => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    const sdkTypePattern = /\bSDKMessage\b|\bSDKUserMessage\b/
    const matches = nonCommentLines.filter(line => sdkTypePattern.test(line))
    expect(matches).toHaveLength(0)
  })

  it('should NOT call query() from SDK', () => {
    const nonCommentLines = source
      .split('\n')
      .filter(line => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    const queryCallLines = nonCommentLines.filter(line =>
      /\bquery\s*\(\s*\{/.test(line),
    )
    expect(queryCallLines).toHaveLength(0)
  })

  it('should call runEngine()', () => {
    expect(source).toContain('runEngine(')
  })

  it('should export WorkerHandler class', () => {
    expect(source).toMatch(/export class WorkerHandler/)
  })

  it('should export SdkEnvConfig interface', () => {
    expect(source).toMatch(/export interface SdkEnvConfig/)
  })

  it('should preserve all public method signatures', () => {
    expect(source).toContain('async executeTask(')
    expect(source).toContain('deliverHumanResponse(')
    expect(source).toContain('cancelTask(')
    expect(source).toContain('getActiveTaskCount()')
    expect(source).toContain('getActiveTasksForQuery()')
  })

  it('should use HumanMessageQueue for message injection', () => {
    expect(source).toContain('HumanMessageQueue')
    expect(source).toContain('humanMessageQueue')
  })

  it('should use AbortController for cancellation instead of SDK handles', () => {
    expect(source).not.toContain('queryHandle')
    expect(source).not.toContain('.interrupt()')
    expect(source).not.toContain('streamInput')
    expect(source).toContain('abortController.abort()')
  })
})
