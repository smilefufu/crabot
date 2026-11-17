import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import path from 'path'
import { runEngine } from '../../src/engine/query-loop.js'
import { defineTool } from '../../src/engine/tool-framework.js'
import type { EngineOptions, EngineToolResultMessage } from '../../src/engine/types.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter.js'
import { chunksFromContent } from './helpers/mock-stream.js'

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, tmpdir: vi.fn(actual.tmpdir) }
})
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})

let root: string
beforeEach(async () => {
  const actualOs = await vi.importActual<typeof import('os')>('os')
  const actualFs = await vi.importActual<typeof import('fs')>('fs')
  vi.mocked(os.tmpdir).mockImplementation(actualOs.tmpdir)
  vi.mocked(fs.writeFileSync).mockImplementation(actualFs.writeFileSync)
  root = fs.mkdtempSync(path.join(actualOs.tmpdir(), 'crabot-image-test-'))
})
afterEach(() => { vi.restoreAllMocks(); vi.mocked(fs.writeFileSync).mockReset(); fs.rmSync(root, { recursive: true, force: true }) })

async function runImages(mediaTypes: string[]) {
  const calls = vi.fn(async () => ({ output: 'downloaded', isError: false,
    images: mediaTypes.map(media_type => ({ media_type, data: Buffer.from('pixels').toString('base64') })) }))
  const tool = defineTool({ name: 'fetch_image', description: '', inputSchema: {}, isReadOnly: true, call: calls })
  let turn = 0
  const adapter: LLMAdapter = { updateConfig() {}, async *stream() {
    yield* chunksFromContent(turn++ === 0
      ? [{ type: 'tool_use', id: 'image-1', name: 'fetch_image', input: {} }, { type: 'tool_use', id: 'image-2', name: 'fetch_image', input: {} }]
      : [{ type: 'text', text: 'done' }], turn === 1 ? 'tool_use' : 'end_turn')
  } }
  const result = await runEngine({ prompt: 'read pictures', adapter,
    options: { model: 'no-vision', systemPrompt: '', tools: [tool], supportsVision: false, maxTurns: 3 } as EngineOptions })
  const toolMessage = result.finalMessages.find(m => 'toolResults' in m) as EngineToolResultMessage
  return { result, calls, results: toolMessage.toolResults }
}

describe('non-vision tool image fallback', () => {
  it('creates the OS temp directory and preserves MIME extensions with unique paths', async () => {
    const temp = path.join(root, '图片 temp directory')
    vi.mocked(os.tmpdir).mockReturnValue(temp)
    vi.spyOn(Date, 'now').mockReturnValue(1794896858053)
    const { result, calls, results } = await runImages(['image/png', 'image/jpeg', 'image/webp'])
    expect(result.outcome).toBe('completed')
    expect(calls).toHaveBeenCalledTimes(2)
    const files = fs.readdirSync(temp)
    expect(files).toHaveLength(6)
    expect(files.map(file => path.extname(file)).sort()).toEqual(['.jpg', '.jpg', '.png', '.png', '.webp', '.webp'])
    for (const item of results) {
      expect(item.is_error).toBeFalsy()
      expect(item.images).toBeUndefined()
      expect(item.content).toContain(temp)
    }
    for (const file of files) expect(fs.readFileSync(path.join(temp, file), 'utf8')).toBe('pixels')
  })

  it('returns a local write failure to the model without losing other results or replaying tools', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs')
    vi.mocked(os.tmpdir).mockReturnValue(root)
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw new Error('EACCES: image write denied') }).mockImplementation(actual.writeFileSync)
    const { result, calls, results } = await runImages(['image/png'])
    expect(result.outcome).toBe('completed')
    expect(calls).toHaveBeenCalledTimes(2)
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ tool_use_id: 'image-1', is_error: true })
    expect(results[0].content).toContain('EACCES')
    expect(results[0].content).not.toContain('Image saved')
    expect(results[1].content).toContain('Image saved')
    expect(results[1].is_error).toBeFalsy()
  })
})
