import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateImage, imageToolsFor, toImageConnInfo } from '../../src/mcp/crab-image.js'

const CONN = { endpoint: 'https://relay.example.com/v1', apikey: 'sk', model_id: 'gpt-image-1' }

function fetchReturning(payload: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch
}

describe('generateImage', () => {
  it('writes b64 image to file and returns path', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'crab-image-'))
    const b64 = Buffer.from('PNGDATA').toString('base64')
    const res = await generateImage(CONN, { prompt: 'a cat' }, {
      outputDir, fetchImpl: fetchReturning({ data: [{ b64_json: b64 }] }),
    })
    expect(res.success).toBe(true)
    if (res.success) {
      expect(res.files).toHaveLength(1)
      expect((await readFile(res.files[0])).toString()).toBe('PNGDATA')
    }
  })

  it('returns readable error on non-2xx', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'crab-image-'))
    const res = await generateImage(CONN, { prompt: 'x' }, {
      outputDir, fetchImpl: fetchReturning({ error: 'bad prompt' }, 400),
    })
    expect(res.success).toBe(false)
    if (!res.success) expect(res.error).toContain('400')
  })

  it('errors when response has no image data (incompatible relay)', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'crab-image-'))
    const res = await generateImage(CONN, { prompt: 'x' }, {
      outputDir, fetchImpl: fetchReturning({ data: [] }),
    })
    expect(res.success).toBe(false)
  })
})

describe('imageToolsFor', () => {
  it('returns [] when no connInfo', () => {
    expect(imageToolsFor(undefined, { moduleId: 'm', outputDir: '/tmp' })).toEqual([])
  })
  it('exposes generate_image when connInfo present', () => {
    const tools = imageToolsFor(CONN, { moduleId: 'm', outputDir: '/tmp' })
    expect(tools.map((t) => t.name)).toContain('mcp__crab-image__generate_image')
  })
})

describe('toImageConnInfo', () => {
  it('picks connection fields from image_config', () => {
    expect(toImageConnInfo({ image_config: { endpoint: 'e', apikey: 'k', model_id: 'gpt-image-1', foo: 1 } as never }))
      .toEqual({ endpoint: 'e', apikey: 'k', model_id: 'gpt-image-1' })
  })
  it('returns undefined when no image_config', () => {
    expect(toImageConnInfo({})).toBeUndefined()
  })
})
