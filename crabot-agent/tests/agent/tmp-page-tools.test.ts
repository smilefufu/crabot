import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTmpPageTools } from '../../src/agent/tmp-page-tools.js'

let currentDataDir = ''

function getTool(name: string) {
  const tools = createTmpPageTools({
    dataDir: currentDataDir,
    getTmpPageBaseUrl: () => 'http://localhost:3000',
    taskId: 'task-123',
    now: () => new Date('2026-07-10T00:00:00.000Z'),
    randomBytes: () => Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
  })
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool
}

async function callTool(name: string, input: Record<string, unknown>) {
  const result = await getTool(name).call(input, {} as never)
  expectNoRuntimeLeak(result.output)
  return { ...result, json: JSON.parse(result.output) as Record<string, unknown> }
}

function expectNoRuntimeLeak(output: string) {
  if (currentDataDir) expect(output).not.toContain(currentDataDir)
  expect(output).not.toContain('$DATA_DIR')
  expect(output).not.toContain('.crabot/data/tmp-pages')
  expect(output).not.toContain('events.jsonl')
  expect(output).not.toContain('CRABOT_TMP_PAGE_PORT')
  expect(output).not.toContain('_manage')
}

describe('tmp-page tools', () => {
  it('creates a page with owner task id and returns no runtime path', async () => {
    currentDataDir = await mkdtemp(path.join(tmpdir(), 'tmp-page-tools-'))

    const result = await callTool('tmp_page_create', {
      title: 'Choice page',
      html: '<!doctype html><button data-choice="a">A</button>',
      ttl_seconds: 3600,
    })

    expect(result.isError).toBe(false)
    expect(result.json).toMatchObject({
      page_id: '00112233445566778899aabbccddeeff',
      url: 'http://localhost:3000/tmp-pages/00112233445566778899aabbccddeeff',
      title: 'Choice page',
      expires_at: '2026-07-10T01:00:00.000Z',
    })
    expect(result.output).not.toContain(currentDataDir)
    expect(result.output).not.toContain('events.jsonl')
    expect(result.output).not.toContain('CRABOT_TMP_PAGE_PORT')
    expect(result.output).not.toContain('_manage')

    const pageDir = path.join(currentDataDir, 'tmp-pages', '00112233445566778899aabbccddeeff')
    const meta = JSON.parse(await readFile(path.join(pageDir, 'meta.json'), 'utf8'))
    expect(meta.owner_task_id).toBe('task-123')
    expect(meta.mode).toBe('single')
    expect(await readFile(path.join(pageDir, 'page.html'), 'utf8')).toContain('data-choice')
  })

  it('updates page content and keeps the same url', async () => {
    currentDataDir = await mkdtemp(path.join(tmpdir(), 'tmp-page-tools-'))
    await callTool('tmp_page_create', { title: 'Initial', html: '<h1>old</h1>' })

    const result = await callTool('tmp_page_update', {
      page_id: '00112233445566778899aabbccddeeff',
      html: '<h1>new</h1>',
      title: 'Updated',
      ttl_seconds: 7200,
    })

    expect(result.isError).toBe(false)
    expect(result.json.url).toBe('http://localhost:3000/tmp-pages/00112233445566778899aabbccddeeff')
    const pageDir = path.join(currentDataDir, 'tmp-pages', '00112233445566778899aabbccddeeff')
    expect(await readFile(path.join(pageDir, 'page.html'), 'utf8')).toContain('new')
    const meta = JSON.parse(await readFile(path.join(pageDir, 'meta.json'), 'utf8'))
    expect(meta.title).toBe('Updated')
    expect(meta.expires_at).toBe('2026-07-10T02:00:00.000Z')
  })

  it('reads events incrementally and marks them untrusted', async () => {
    currentDataDir = await mkdtemp(path.join(tmpdir(), 'tmp-page-tools-'))
    await callTool('tmp_page_create', { title: 'Feedback', html: '<button>ok</button>' })
    const pageDir = path.join(currentDataDir, 'tmp-pages', '00112233445566778899aabbccddeeff')
    await writeFile(
      path.join(pageDir, 'events.jsonl'),
      [
        JSON.stringify({ at: '2026-07-10T00:01:00.000Z', data: { choice: 'a' } }),
        'not-json',
        JSON.stringify({ at: '2026-07-10T00:02:00.000Z', data: { choice: 'b' } }),
      ].join('\n') + '\n',
    )

    const result = await callTool('tmp_page_read_events', {
      page_id: '00112233445566778899aabbccddeeff',
      after_event_id: 1,
    })

    expect(result.isError).toBe(false)
    expect(result.json.events).toEqual([
      { event_id: 2, at: expect.any(String), data: 'not-json', trusted: false },
      { event_id: 3, at: '2026-07-10T00:02:00.000Z', data: { choice: 'b' }, trusted: false },
    ])
    expect(result.json.next_after_event_id).toBe(3)
    expect(result.output).not.toContain('events.jsonl')
  })

  it('lists and deletes pages without leaking paths', async () => {
    currentDataDir = await mkdtemp(path.join(tmpdir(), 'tmp-page-tools-'))
    await callTool('tmp_page_create', { title: 'List me', html: '<h1>x</h1>', mode: 'multi' })

    const list = await callTool('tmp_page_list', {})
    expect(list.isError).toBe(false)
    expect(list.json.pages).toEqual([expect.objectContaining({
      page_id: '00112233445566778899aabbccddeeff',
      url: 'http://localhost:3000/tmp-pages/00112233445566778899aabbccddeeff',
      title: 'List me',
      owner_task_id: 'task-123',
      mode: 'multi',
    })])
    expect(list.output).not.toContain(currentDataDir)
    expect(list.output).not.toContain('_manage')

    const del = await callTool('tmp_page_delete', { page_id: '00112233445566778899aabbccddeeff' })
    expect(del.isError).toBe(false)
    await expect(stat(path.join(currentDataDir, 'tmp-pages', '00112233445566778899aabbccddeeff'))).rejects.toThrow()
  })

  it('returns structured errors for bad input and missing pages', async () => {
    currentDataDir = await mkdtemp(path.join(tmpdir(), 'tmp-page-tools-'))

    const missingBase = createTmpPageTools({
      dataDir: currentDataDir,
      getTmpPageBaseUrl: () => undefined,
      taskId: 'task-123',
    }).find((t) => t.name === 'tmp_page_create')!
    const noBase = await missingBase.call({ title: 'x', html: '<p>x</p>' }, {} as never)
    expect(noBase.isError).toBe(true)
    expect(noBase.output).toContain('TMP_PAGE_BASE_URL_MISSING')
    expectNoRuntimeLeak(noBase.output)

    const missingRead = await callTool('tmp_page_read_events', { page_id: 'abcdefghijklmnop' })
    expect(missingRead.isError).toBe(true)
    expect(missingRead.json).toEqual({
      success: false,
      error_code: 'TMP_PAGE_NOT_FOUND',
      page_id: 'abcdefghijklmnop',
    })

    await mkdir(path.join(currentDataDir, 'tmp-pages'), { recursive: true })
    const badId = await callTool('tmp_page_delete', { page_id: '../bad' })
    expect(badId.isError).toBe(true)
    expect(badId.output).toContain('TMP_PAGE_INVALID_ID')
  })

  it('exports exactly the Worker-facing tmp_page tools and no wait tool', async () => {
    currentDataDir = await mkdtemp(path.join(tmpdir(), 'tmp-page-tools-'))
    const names = createTmpPageTools({
      dataDir: currentDataDir,
      getTmpPageBaseUrl: () => 'http://localhost:3000',
      taskId: 'task-123',
    }).map((tool) => tool.name)

    expect(names).toEqual([
      'tmp_page_create',
      'tmp_page_update',
      'tmp_page_read_events',
      'tmp_page_delete',
      'tmp_page_list',
    ])
    expect(names).not.toContain('tmp_page_wait_feedback')
  })
})
