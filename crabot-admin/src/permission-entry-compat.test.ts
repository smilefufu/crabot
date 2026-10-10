import { describe, expect, it } from 'vitest'
import { PermissionTemplateManager } from './permission-template-manager.js'
import { createToolAccessConfig } from './types.js'

describe('retired authorization fields', () => {
  it('rejects a new template granting a retired entry', () => {
    const manager = new PermissionTemplateManager()
    expect(() => manager.create({ name: 'fixture', tool_access: { ...createToolAccessConfig(false), task: true } })).toThrow(/退役|retired/)
  })
  it('preserves retired fields when a legacy stored template updates effective fields', () => {
    const manager = new PermissionTemplateManager()
    const old = manager.create({ name: 'fixture', tool_access: createToolAccessConfig(false) })
    manager.upsertById({ ...old, tool_access: { ...old.tool_access, task: true, browser: true } }, 'overwrite')
    const { task, browser, remote_exec, ...effective } = old.tool_access
    const updated = manager.update(old.id, { tool_access: { ...effective, shell: true } as never })
    expect(updated.tool_access).toMatchObject({ task: true, browser: true, remote_exec: false, shell: true })
    expect(() => manager.update(old.id, { tool_access: { ...updated.tool_access, task: false } })).toThrow(/退役|retired/)
  })
})
