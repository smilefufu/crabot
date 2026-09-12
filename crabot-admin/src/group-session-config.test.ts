import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminModule from './index.js'
import { PermissionTemplateManager } from './permission-template-manager.js'
import { createToolAccessConfig } from './types.js'
import { groupSessionConfigKey, loadGroupSessionConfigs, parseGroupSessionConfig, serializeGroupSessionConfigs } from './group-session-config.js'

describe('group session permission persistence', () => {
  let directory: string
  let file: string
  const legacy = { session_id: 'shared', config: { template_id: 'master_private', tool_access: { mcp_skill: true } } }
  const current = { channel_id: 'channel-a', session_id: 'shared', config: {
    cli_access: { schedule: 'none' }, tool_access: { mcp_skill: true }, updated_at: '2026-09-12T00:00:00.000Z',
  } }

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-group-config-test-'))
    file = path.join(directory, 'session-configs.json')
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('backs up legacy records before removing them and keeps composite records through restart', async () => {
    await fs.writeFile(file, JSON.stringify([legacy, current]))
    const loaded = await loadGroupSessionConfigs(file)
    expect(loaded.has('shared')).toBe(false)
    expect(loaded.get(groupSessionConfigKey('channel-a', 'shared'))).toEqual({ ...current.config, tool_access: { mcp_skill: true, desktop: false } })
    const quarantine = (await fs.readdir(directory)).find(name => name.includes('.quarantine-'))!
    expect(JSON.parse(await fs.readFile(path.join(directory, quarantine, 'records.json'), 'utf8'))).toEqual([legacy])
    expect(JSON.parse(await fs.readFile(path.join(directory, quarantine, 'report.json'), 'utf8'))).toMatchObject({ source: 'startup', isolated_count: 1 })
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(serializeGroupSessionConfigs(loaded))
    expect(await loadGroupSessionConfigs(file)).toEqual(loaded)
    expect((await fs.readdir(directory)).filter(name => name.includes('.quarantine-'))).toHaveLength(1)
  })

  it('cannot overwrite the source when backup/report creation fails', async () => {
    const data = JSON.stringify([legacy])
    await fs.writeFile(file, data)
    const writeFile = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation(async (destination, ...args) => {
      if (String(destination).endsWith('report.json')) throw new Error('disk full')
      return writeFile(destination, ...args)
    })
    await expect(loadGroupSessionConfigs(file)).rejects.toThrow('disk full')
    expect(await fs.readFile(file, 'utf8')).toBe(data)
  })

  it('does not treat corrupt or unreadable permission stores as an empty valid store', async () => {
    await fs.writeFile(file, '{broken')
    await expect(loadGroupSessionConfigs(file)).rejects.toThrow()
    expect(await fs.readFile(file, 'utf8')).toBe('{broken')
  })

  it('legacy backup import is isolated on every import and never enters the active map', async () => {
    const admin = Object.create(AdminModule.prototype) as any
    admin.sessionConfigsFilePath = file
    admin.sessionConfigs = new Map()
    const deps = admin.buildCrabotImportDeps('unused-test-archive', 'overwrite')
    expect(await deps.upsertSessionConfig(legacy)).toBe('skipped')
    expect(await deps.upsertSessionConfig(legacy)).toBe('skipped')
    expect(admin.sessionConfigs.size).toBe(0)
    expect((await fs.readdir(directory)).filter(name => name.includes('.quarantine-'))).toHaveLength(2)
  })

  it('validates the target of new-shape imports before allowing overwrite', async () => {
    const admin = Object.create(AdminModule.prototype) as any
    admin.sessionConfigs = new Map()
    admin.resolvePermissionTarget = vi.fn(async () => { throw new Error('not a group') })
    const deps = admin.buildCrabotImportDeps('unused-test-archive', 'overwrite')
    await expect(deps.upsertSessionConfig(current)).rejects.toThrow('not a group')
    expect(admin.sessionConfigs.size).toBe(0)
  })

  it('legacy backup templates cannot replace the immutable narrow group default', async () => {
    const templates = new PermissionTemplateManager()
    templates.initSystemTemplates()
    const admin = Object.create(AdminModule.prototype) as any
    admin.permissionTemplateManager = templates
    const deps = admin.buildCrabotImportDeps('unused-test-archive', 'overwrite')
    const previous = structuredClone(templates.get('group_default')!)
    expect(await deps.upsertTemplate({ ...previous, is_system: false, tool_access: createToolAccessConfig(true) })).toBe('skipped')
    expect(templates.get('group_default')).toEqual(previous)
    expect(await deps.upsertTemplate({ ...previous, id: 'custom', is_system: false })).toBe('imported')
  })

  it('keeps unset fields unset and preserves explicit CLI denials', () => {
    expect(parseGroupSessionConfig({ cli_access: { schedule: 'none' } })).toEqual({
      cli_access: { schedule: 'none' }, tool_access: { desktop: false }, updated_at: expect.any(String),
    })
    expect(groupSessionConfigKey('a::b', 'c')).not.toBe(groupSessionConfigKey('a', 'b::c'))
  })
})
