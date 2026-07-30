/**
 * crabot-info 只读方法集测试 —— protocol-agent-v3.md §4.3。
 *
 * 覆盖:
 * - 六个方法各自返回结构正确(mock callAdmin)
 * - get_config_summary 对含 api_key/token/secret 的负载完成掩码(含嵌套对象/数组)
 * - 全部工具 isReadOnly === true
 * - 工具名集合恰为六项(防后人误增写操作)
 */
import { describe, it, expect, vi } from 'vitest'
import { buildCrabotInfoTools } from '../../src/manager/tools/crabot-info'

function makeCallAdmin(handlers: Record<string, (params: unknown) => unknown>) {
  return vi.fn(async (method: string, params: unknown) => {
    const handler = handlers[method]
    if (!handler) throw new Error(`unexpected admin RPC call: ${method}`)
    return handler(params)
  })
}

describe('buildCrabotInfoTools', () => {
  it('工具名集合恰为六项', () => {
    const tools = buildCrabotInfoTools({ callAdmin: makeCallAdmin({}) })
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'get_config_summary',
        'get_deployment_info',
        'get_friend_permissions',
        'get_system_status',
        'list_capabilities',
        'list_schedules',
      ].sort(),
    )
  })

  it('全部工具 isReadOnly === true', () => {
    const tools = buildCrabotInfoTools({ callAdmin: makeCallAdmin({}) })
    for (const t of tools) {
      expect(t.isReadOnly).toBe(true)
    }
  })

  describe('get_system_status', () => {
    it('组合 get_task_stats / list_agent_instances / list_channel_instances 返回摘要', async () => {
      const callAdmin = makeCallAdmin({
        get_task_stats: () => ({
          total: 5,
          by_status: { executing: 2, completed: 3 },
          by_priority: { normal: 5 },
        }),
        list_agent_instances: () => ({
          items: [{ id: 'crabot-agent' }],
          pagination: { page: 1, page_size: 100, total_items: 1, total_pages: 1 },
        }),
        list_channel_instances: () => ({
          items: [{ id: 'wechat-1' }, { id: 'web-1' }],
          pagination: { page: 1, page_size: 100, total_items: 2, total_pages: 1 },
        }),
      })
      const tools = buildCrabotInfoTools({ callAdmin })
      const tool = tools.find((t) => t.name === 'get_system_status')!
      const result = await tool.call({}, {})
      expect(result.isError).toBe(false)
      const parsed = JSON.parse(result.output)
      expect(parsed.task_stats.total).toBe(5)
      expect(parsed.agent_instance_count).toBe(1)
      expect(parsed.channel_instance_count).toBe(2)
    })

    it('admin RPC 失败时返回 isError', async () => {
      const callAdmin = vi.fn(async () => {
        throw new Error('admin unreachable')
      })
      const tools = buildCrabotInfoTools({ callAdmin })
      const tool = tools.find((t) => t.name === 'get_system_status')!
      const result = await tool.call({}, {})
      expect(result.isError).toBe(true)
      expect(result.output).toContain('admin unreachable')
    })
  })

  describe('get_deployment_info', () => {
    it('组合 list_agent_instances / list_channel_instances 返回拓扑详情', async () => {
      const callAdmin = makeCallAdmin({
        list_agent_instances: () => ({
          items: [
            { id: 'crabot-agent', name: 'Default Agent', implementation_id: 'builtin', module_registered: true, module_port: 4101 },
          ],
          pagination: { page: 1, page_size: 100, total_items: 1, total_pages: 1 },
        }),
        list_channel_instances: () => ({
          items: [
            { id: 'wechat-1', name: 'WeChat', platform: 'wechat', module_registered: true },
          ],
          pagination: { page: 1, page_size: 100, total_items: 1, total_pages: 1 },
        }),
      })
      const tools = buildCrabotInfoTools({ callAdmin })
      const tool = tools.find((t) => t.name === 'get_deployment_info')!
      const result = await tool.call({}, {})
      expect(result.isError).toBe(false)
      const parsed = JSON.parse(result.output)
      expect(parsed.agent_instances).toEqual([
        { id: 'crabot-agent', name: 'Default Agent', implementation_id: 'builtin', module_registered: true, module_port: 4101 },
      ])
      expect(parsed.channel_instances).toEqual([
        { id: 'wechat-1', name: 'WeChat', platform: 'wechat', module_registered: true },
      ])
    })
  })

  describe('list_schedules', () => {
    it('透传参数与结果', async () => {
      const callAdmin = makeCallAdmin({
        list_schedules: (params) => {
          expect(params).toEqual({ filter: { enabled: true }, page: 1, page_size: 20 })
          return {
            items: [{ id: 'sched-1', name: 'daily', enabled: true }],
            pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 },
          }
        },
      })
      const tools = buildCrabotInfoTools({ callAdmin })
      const tool = tools.find((t) => t.name === 'list_schedules')!
      const result = await tool.call({ enabled: true }, {})
      expect(result.isError).toBe(false)
      const parsed = JSON.parse(result.output)
      expect(parsed.items).toEqual([{ id: 'sched-1', name: 'daily', enabled: true }])
    })

    it('无参数时用默认分页', async () => {
      const callAdmin = makeCallAdmin({
        list_schedules: (params) => {
          expect(params).toEqual({ page: 1, page_size: 20 })
          return { items: [], pagination: { page: 1, page_size: 20, total_items: 0, total_pages: 0 } }
        },
      })
      const tools = buildCrabotInfoTools({ callAdmin })
      const tool = tools.find((t) => t.name === 'list_schedules')!
      const result = await tool.call({}, {})
      expect(result.isError).toBe(false)
    })
  })

  describe('get_config_summary', () => {
    it('对 api_key/token/secret/password/credential 字段(含嵌套对象与数组)完成掩码', async () => {
      const callAdmin = makeCallAdmin({
        get_agent_config: (params) => {
          expect(params).toEqual({ instance_id: 'crabot-agent' })
          return {
            config: {
              instance_id: 'crabot-agent',
              model_config: {
                default: {
                  endpoint: 'https://api.example.com',
                  apikey: 'sk-real-secret-value',
                  model_id: 'gpt-4o',
                  format: 'openai',
                },
                smart: {
                  endpoint: 'https://api.anthropic.com',
                  apikey: 'sk-another-secret',
                  model_id: 'claude-x',
                  format: 'anthropic',
                },
              },
              subagents: [
                {
                  id: 'sub-1',
                  model: { endpoint: 'https://x', apikey: 'nested-secret', model_id: 'm' },
                },
              ],
              nested: {
                auth: { password: 'p4ss', token: 't0k', secret_key: 'sek' },
              },
              non_sensitive_field: 'keep-me',
            },
          }
        },
      })
      const tools = buildCrabotInfoTools({ callAdmin })
      const tool = tools.find((t) => t.name === 'get_config_summary')!
      const result = await tool.call({}, {})
      expect(result.isError).toBe(false)
      const parsed = JSON.parse(result.output)

      expect(parsed.config.model_config.default.apikey).toBe('***')
      expect(parsed.config.model_config.smart.apikey).toBe('***')
      expect(parsed.config.model_config.default.endpoint).toBe('https://api.example.com')
      expect(parsed.config.subagents[0].model.apikey).toBe('***')
      expect(parsed.config.nested.auth.password).toBe('***')
      expect(parsed.config.nested.auth.token).toBe('***')
      expect(parsed.config.nested.auth.secret_key).toBe('***')
      expect(parsed.config.non_sensitive_field).toBe('keep-me')
    })

    it('支持传入 instance_id 覆盖默认值', async () => {
      const callAdmin = makeCallAdmin({
        get_agent_config: (params) => {
          expect(params).toEqual({ instance_id: 'other-instance' })
          return { config: { instance_id: 'other-instance', model_config: {} } }
        },
      })
      const tools = buildCrabotInfoTools({ callAdmin })
      const tool = tools.find((t) => t.name === 'get_config_summary')!
      const result = await tool.call({ instance_id: 'other-instance' }, {})
      expect(result.isError).toBe(false)
    })
  })

  describe('list_capabilities', () => {
    it('组合 list_agent_implementations / list_channel_implementations', async () => {
      const callAdmin = makeCallAdmin({
        list_agent_implementations: () => ({
          items: [
            { id: 'builtin', name: 'Builtin', type: 'builtin', implementation_type: 'in_process', engine: 'claude', supported_roles: ['worker'] },
          ],
          pagination: { page: 1, page_size: 100, total_items: 1, total_pages: 1 },
        }),
        list_channel_implementations: () => ({
          items: [
            { id: 'wechat', name: 'WeChat', type: 'builtin', platform: 'wechat', version: '1.0.0' },
          ],
          pagination: { page: 1, page_size: 100, total_items: 1, total_pages: 1 },
        }),
      })
      const tools = buildCrabotInfoTools({ callAdmin })
      const tool = tools.find((t) => t.name === 'list_capabilities')!
      const result = await tool.call({}, {})
      expect(result.isError).toBe(false)
      const parsed = JSON.parse(result.output)
      expect(parsed.agent_implementations).toEqual([
        { id: 'builtin', name: 'Builtin', type: 'builtin', implementation_type: 'in_process', engine: 'claude', supported_roles: ['worker'] },
      ])
      expect(parsed.channel_implementations).toEqual([
        { id: 'wechat', name: 'WeChat', type: 'builtin', platform: 'wechat', version: '1.0.0' },
      ])
    })
  })

  describe('get_friend_permissions', () => {
    it('透传 friend_id 并返回 config/resolved', async () => {
      const callAdmin = makeCallAdmin({
        get_friend_permissions: (params) => {
          expect(params).toEqual({ friend_id: 'friend-123' })
          return {
            config: { tool_access: {}, cli_access: {}, storage: null, memory_scopes: [], updated_at: '2026-01-01' },
            resolved: { tool_access: {}, cli_access: {}, storage: null, memory_scopes: [] },
          }
        },
      })
      const tools = buildCrabotInfoTools({ callAdmin })
      const tool = tools.find((t) => t.name === 'get_friend_permissions')!
      const result = await tool.call({ friend_id: 'friend-123' }, {})
      expect(result.isError).toBe(false)
      const parsed = JSON.parse(result.output)
      expect(parsed.resolved).toEqual({ tool_access: {}, cli_access: {}, storage: null, memory_scopes: [] })
    })

    it('缺少 friend_id 时报错且不调用 admin', async () => {
      const callAdmin = makeCallAdmin({})
      const tools = buildCrabotInfoTools({ callAdmin })
      const tool = tools.find((t) => t.name === 'get_friend_permissions')!
      const result = await tool.call({}, {})
      expect(result.isError).toBe(true)
      expect(callAdmin).not.toHaveBeenCalled()
    })
  })
})
