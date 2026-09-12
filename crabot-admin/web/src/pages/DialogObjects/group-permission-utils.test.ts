import { describe, expect, it } from 'vitest'
import { createCliAccessConfig, type PermissionTemplate } from '../../types'
import { buildGroupPermissionOverrides, resolveGroupPermissions } from './group-permission-utils'

const template: PermissionTemplate = {
  id: 'group_scheduler', name: 'Group', is_system: true,
  tool_access: { memory: true, messaging: true, task: false, mcp_skill: false, file_io: false, browser: false, shell: false, remote_exec: false, desktop: false },
  cli_access: { ...createCliAccessConfig('none'), schedule: 'write' },
  storage: null, memory_scopes: [], created_at: '2026-09-12T00:00:00.000Z', updated_at: '2026-09-12T00:00:00.000Z',
}

describe('group permission partial overrides', () => {
  it('does not turn unchanged defaults into an explicit permission snapshot', () => {
    expect(buildGroupPermissionOverrides('group', template, resolveGroupPermissions('group', template, null), null)).toEqual({ template_id: template.id })
  })

  it('inherits unspecified CLI domains and keeps explicit none as a denial', () => {
    const config = { cli_access: { schedule: 'none' as const, mcp: 'read' as const }, updated_at: template.updated_at }
    const resolved = resolveGroupPermissions('group', template, config)
    expect(resolved.cli_access).toEqual({ ...createCliAccessConfig('none'), mcp: 'read' })
    expect(buildGroupPermissionOverrides('group', template, resolved, config)).toMatchObject({ cli_access: config.cli_access })
  })

  it('preserves explicit values equal to defaults, including null storage and empty memory scopes', () => {
    const config = { tool_access: { memory: true }, cli_access: { mcp: 'none' as const }, storage: null, memory_scopes: [], updated_at: template.updated_at }
    expect(buildGroupPermissionOverrides('group', template, resolveGroupPermissions('group', template, config), config)).toEqual({
      template_id: template.id, tool_access: config.tool_access, cli_access: config.cli_access, storage: null, memory_scopes: [],
    })
  })

  it('stores only changed domains and never enables group desktop', () => {
    const resolved = resolveGroupPermissions('group', template, null)
    resolved.tool_access.mcp_skill = true
    resolved.tool_access.desktop = true
    resolved.cli_access.schedule = 'none'
    expect(buildGroupPermissionOverrides('group', template, resolved, null)).toEqual({
      template_id: template.id, tool_access: { mcp_skill: true }, cli_access: { schedule: 'none' },
    })
  })
})
