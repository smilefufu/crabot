import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { gatherCategories, type GatherDeps } from './gather.js'
import { SECRET_PLACEHOLDER } from './scrub-secrets.js'

async function tmpdir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'backup-gather-'))
}

describe('gatherCategories', () => {
  let adminDir: string
  let memoryDir: string
  let staging: string

  beforeEach(async () => {
    adminDir = await tmpdir()
    memoryDir = await tmpdir()
    staging = await tmpdir()
    await fs.writeFile(
      path.join(adminDir, 'model_providers.json'),
      JSON.stringify([{ id: 'p1', name: 'openai', api_key: 'sk-real' }]),
    )
    await fs.writeFile(path.join(adminDir, 'tasks.json'), '[]')
    await fs.writeFile(path.join(adminDir, 'schedules.json'), '[]')
    await fs.mkdir(path.join(memoryDir, 'long_term', 'confirmed', 'fact'), { recursive: true })
    await fs.writeFile(path.join(memoryDir, 'long_term', 'confirmed', 'fact', 'm1.md'), '# hi')
  })

  function deps(): GatherDeps {
    return { adminDataDir: adminDir, memoryDataDir: memoryDir }
  }

  it('不含密钥时 providers 的 api_key 被置空', async () => {
    await gatherCategories({
      staging, selection: { categories: ['config'], includeSecrets: false }, deps: deps(),
    })
    const raw = await fs.readFile(path.join(staging, 'payload', 'config', 'model_providers.json'), 'utf-8')
    expect(JSON.parse(raw)[0].api_key).toBe(SECRET_PLACEHOLDER)
  })

  it('含密钥时 providers 的 api_key 原样保留', async () => {
    await gatherCategories({
      staging, selection: { categories: ['config'], includeSecrets: true }, deps: deps(),
    })
    const raw = await fs.readFile(path.join(staging, 'payload', 'config', 'model_providers.json'), 'utf-8')
    expect(JSON.parse(raw)[0].api_key).toBe('sk-real')
  })

  it('memory 类别复制 long_term 目录', async () => {
    await gatherCategories({
      staging, selection: { categories: ['memory'], includeSecrets: false }, deps: deps(),
    })
    const md = await fs.readFile(
      path.join(staging, 'payload', 'memory', 'long_term', 'confirmed', 'fact', 'm1.md'), 'utf-8',
    )
    expect(md).toBe('# hi')
  })

  it('提供 exportShortTermMemory 回调时写 short_term.json', async () => {
    const d: GatherDeps = { ...deps(), exportShortTermMemory: async () => ({ version: '1.1', short_term: [] }) }
    await gatherCategories({ staging, selection: { categories: ['memory'], includeSecrets: false }, deps: d })
    const raw = await fs.readFile(path.join(staging, 'payload', 'memory', 'short_term.json'), 'utf-8')
    expect(JSON.parse(raw).version).toBe('1.1')
  })

  it('缺失的可选文件不报错', async () => {
    await expect(
      gatherCategories({ staging, selection: { categories: ['config'], includeSecrets: true }, deps: deps() }),
    ).resolves.toBeUndefined()
  })

  it('过滤内置 subagents/templates，只导用户自建', async () => {
    await fs.writeFile(
      path.join(adminDir, 'subagents.json'),
      JSON.stringify([
        { id: 'builtin-x', name: 'bx', is_builtin: true },
        { id: 'user-y', name: 'uy', is_builtin: false },
      ]),
    )
    await fs.writeFile(
      path.join(adminDir, 'templates.json'),
      JSON.stringify([
        { id: 'sys-t', is_system: true },
        { id: 'usr-t', is_system: false },
      ]),
    )
    await gatherCategories({
      staging, selection: { categories: ['config'], includeSecrets: true }, deps: deps(),
    })
    const subs = JSON.parse(
      await fs.readFile(path.join(staging, 'payload', 'config', 'subagents.json'), 'utf-8'),
    )
    expect(subs.map((s: { id: string }) => s.id)).toEqual(['user-y'])
    const tmpls = JSON.parse(
      await fs.readFile(path.join(staging, 'payload', 'config', 'templates.json'), 'utf-8'),
    )
    expect(tmpls.map((t: { id: string }) => t.id)).toEqual(['usr-t'])
  })

  it('skills 目录只拷保留条目对应子目录（按 name）', async () => {
    await fs.writeFile(
      path.join(adminDir, 'skills.json'),
      JSON.stringify([
        { id: 'builtin-skill-a', name: 'a', is_builtin: true },
        { id: 'usr-skill-b', name: 'b', is_builtin: false },
      ]),
    )
    await fs.mkdir(path.join(adminDir, 'skills', 'a'), { recursive: true })
    await fs.writeFile(path.join(adminDir, 'skills', 'a', 'SKILL.md'), '# a')
    await fs.mkdir(path.join(adminDir, 'skills', 'b'), { recursive: true })
    await fs.writeFile(path.join(adminDir, 'skills', 'b', 'SKILL.md'), '# b')
    await gatherCategories({
      staging, selection: { categories: ['skills'], includeSecrets: true }, deps: deps(),
    })
    const skillsJson = JSON.parse(
      await fs.readFile(path.join(staging, 'payload', 'skills', 'skills.json'), 'utf-8'),
    )
    expect(skillsJson.map((s: { id: string }) => s.id)).toEqual(['usr-skill-b'])
    await expect(
      fs.access(path.join(staging, 'payload', 'skills', 'skills', 'a')),
    ).rejects.toThrow()
    const keptDir = await fs.readFile(
      path.join(staging, 'payload', 'skills', 'skills', 'b', 'SKILL.md'), 'utf-8',
    )
    expect(keptDir).toBe('# b')
  })

  it('exports stable schedule/config references without channel-local sessions cache', async () => {
    await fs.writeFile(
      path.join(adminDir, 'channel-instances.json'),
      JSON.stringify([{ id: 'wechat-1', type: 'wechat', name: 'wechat' }]),
    )
    await fs.mkdir(path.join(adminDir, 'channels', 'wechat-1'), { recursive: true })
    await fs.writeFile(
      path.join(adminDir, 'channels', 'wechat-1', 'sessions.json'),
      JSON.stringify([{ id: 'cache-only-session', platform_session_id: '12345@chatroom' }]),
    )
    await fs.writeFile(
      path.join(adminDir, 'schedules.json'),
      JSON.stringify([
        {
          id: 'sched-1',
          name: 'stable schedule',
          trigger: { type: 'cron', expression: '0 0 * * *' },
          task_template: { type: 'routine', title: 'daily', priority: 'normal', tags: [] },
          enabled: true,
          target_session: {
            channel_id: 'wechat-1',
            session_id: 'stable-abc',
            platform_session_id: '12345@chatroom',
            type: 'group',
          },
          created_at: '2026-07-04T00:00:00.000Z',
          updated_at: '2026-07-04T00:00:00.000Z',
        },
      ]),
    )
    await fs.writeFile(
      path.join(adminDir, 'session-configs.json'),
      JSON.stringify([{ session_id: 'stable-abc', config: { updated_at: '2026-07-04T00:00:00.000Z' } }]),
    )

    await gatherCategories({
      staging,
      selection: { categories: ['channels', 'tasks', 'config'], includeSecrets: true },
      deps: deps(),
    })

    await expect(
      fs.access(path.join(staging, 'payload', 'channels', 'channels', 'wechat-1', 'sessions.json')),
    ).rejects.toThrow()

    const schedules = JSON.parse(
      await fs.readFile(path.join(staging, 'payload', 'tasks', 'schedules.json'), 'utf-8'),
    )
    expect(schedules[0].target_session).toEqual({
      channel_id: 'wechat-1',
      session_id: 'stable-abc',
      platform_session_id: '12345@chatroom',
      type: 'group',
    })

    const sessionConfigs = JSON.parse(
      await fs.readFile(path.join(staging, 'payload', 'config', 'session-configs.json'), 'utf-8'),
    )
    expect(sessionConfigs).toEqual([
      { session_id: 'stable-abc', config: { updated_at: '2026-07-04T00:00:00.000Z' } },
    ])
  })
})
