import { describe, expect, it } from 'vitest'
import type { MCPServerConfig, ResolvedPermissions, SkillConfig } from '../../src/types.js'
import {
  buildWorkerCapabilityBundle,
  CRABOT_BUILTIN_SKILL_NAMES,
  TMP_PAGE_BRIDGE_ENV,
  TMP_PAGE_MCP_SERVER_NAME,
} from '../../src/workers/capability-policy.js'
import type { WorkerImplId } from '../../src/workers/types.js'

const builtinSkills = [...CRABOT_BUILTIN_SKILL_NAMES].map((name) => ({
  id: `builtin-${name}`,
  name,
  description: name,
  skill_dir: `/skills/${name}`,
})) satisfies SkillConfig[]

const userSkill: SkillConfig = {
  id: 'user-skill',
  name: 'user-skill',
  description: 'user skill',
  skill_dir: '/skills/user-skill',
}

function permissions(mcpSkill: boolean): ResolvedPermissions {
  return {
    tool_access: {
      memory: false,
      messaging: false,
      task: false,
      mcp_skill: mcpSkill,
      file_io: true,
      browser: true,
      shell: true,
      remote_exec: false,
      desktop: false,
    },
    cli_access: {
      provider: 'none', agent: 'none', mcp: 'none', skill: 'none', schedule: 'none',
      channel: 'none', friend: 'none', permission: 'none', config: 'none', undo: 'none',
    },
    storage: null,
    memory_scopes: [],
  }
}

const externalServers: MCPServerConfig[] = [
  { name: 'git', transport: 'stdio', command: 'git-mcp' },
  { name: 'scrapling', transport: 'stdio', command: 'scrapling-mcp' },
]

const bridge = {
  command: '/usr/bin/node',
  args: ['/opt/crabot/crabot-agent/dist/mcp/tmp-page-stdio-server.js'],
  dataDir: '/var/lib/crabot',
  baseUrl: 'https://crabot.example',
  port: 19099,
} as const

function bundle(impl: WorkerImplId, mcpSkill = true) {
  return buildWorkerCapabilityBundle({
    impl,
    workerId: 'worker-1',
    permissions: permissions(mcpSkill),
    skills: [...builtinSkills, userSkill],
    mcpServers: externalServers,
    ...(impl === 'builtin' ? {} : { tmpPageBridge: bridge }),
  })
}

describe('mainline Worker capability policy', () => {
  it('策略清单精确覆盖 spec 中的八个 Crabot 内置 Skill', () => {
    expect([...CRABOT_BUILTIN_SKILL_NAMES]).toEqual([
      'tmp-page',
      'scrapling-official',
      'workspace-context-maintenance',
      'writing-plans',
      'systematic-debugging',
      'verification-before-completion',
      'memory-graph-linking',
      'crabot-cli',
    ])
  })

  it('三种实现共用主线 Skill 选择，排除 direct-child-only 与已退役内置 Skill', () => {
    const namesByImpl = (['builtin', 'claude-code', 'codex'] as const).map((impl) =>
      bundle(impl).skills.map((skill) => skill.name),
    )

    expect(namesByImpl[1]).toEqual(namesByImpl[0])
    expect(namesByImpl[2]).toEqual(namesByImpl[0])
    expect(namesByImpl[0]).toEqual([
      'tmp-page',
      'scrapling-official',
      'workspace-context-maintenance',
      'user-skill',
    ])
  })

  it('第三方 MCP/Skill 权限关闭时仍保留两个 Crabot 必需 Skill 和 CLI tmp-page bridge', () => {
    const result = bundle('codex', false)

    expect(result.skills.map((skill) => skill.name)).toEqual([
      'tmp-page',
      'workspace-context-maintenance',
    ])
    expect(result.mcp_servers.map((server) => server.name)).toEqual([TMP_PAGE_MCP_SERVER_NAME])
  })

  it('缺少任一必需内置 Skill 时 fail-loud 并指出名称', () => {
    expect(() => buildWorkerCapabilityBundle({
      impl: 'builtin',
      workerId: 'worker-1',
      permissions: permissions(true),
      skills: builtinSkills.filter((skill) => skill.name !== 'tmp-page'),
      mcpServers: externalServers,
    })).toThrow("required Crabot builtin Skill 'tmp-page' is unavailable")
  })

  it('Scrapling MCP 可用时缺少对应 Skill 必须 fail-loud', () => {
    expect(() => buildWorkerCapabilityBundle({
      impl: 'builtin',
      workerId: 'worker-1',
      permissions: permissions(true),
      skills: builtinSkills.filter((skill) => skill.name !== 'scrapling-official'),
      mcpServers: externalServers,
    })).toThrow("required Crabot builtin Skill 'scrapling-official' is unavailable")
  })

  it('CLI bundle 追加绑定 worker_id 的受控 stdio entry，builtin 不追加', () => {
    expect(bundle('builtin').mcp_servers.map((server) => server.name)).toEqual(['git', 'scrapling'])

    const cliEntry = bundle('claude-code').mcp_servers.at(-1)!
    expect(cliEntry).toEqual({
      name: TMP_PAGE_MCP_SERVER_NAME,
      transport: 'stdio',
      command: bridge.command,
      args: [...bridge.args],
      env: {
        [TMP_PAGE_BRIDGE_ENV.dataDir]: bridge.dataDir,
        [TMP_PAGE_BRIDGE_ENV.baseUrl]: bridge.baseUrl,
        [TMP_PAGE_BRIDGE_ENV.workerId]: 'worker-1',
        [TMP_PAGE_BRIDGE_ENV.port]: String(bridge.port),
      },
    })
  })

  it('CLI 缺少 bridge 或 bridge 参数非法时拒绝生成能力快照', () => {
    expect(() => buildWorkerCapabilityBundle({
      impl: 'codex',
      workerId: 'worker-1',
      permissions: permissions(true),
      skills: builtinSkills,
      mcpServers: [],
    })).toThrow('requires the tmp-page stdio bridge')

    expect(() => buildWorkerCapabilityBundle({
      impl: 'codex',
      workerId: 'worker-1',
      permissions: permissions(true),
      skills: builtinSkills,
      mcpServers: [],
      tmpPageBridge: { ...bridge, port: Number.NaN },
    })).toThrow('tmp-page bridge port is invalid')

    expect(() => buildWorkerCapabilityBundle({
      impl: 'codex',
      workerId: 'worker-1',
      permissions: permissions(true),
      skills: builtinSkills,
      mcpServers: [],
      tmpPageBridge: { ...bridge, dataDir: './data' },
    })).toThrow('tmp-page bridge data directory must be absolute')

    expect(() => buildWorkerCapabilityBundle({
      impl: 'codex',
      workerId: 'worker-1',
      permissions: permissions(true),
      skills: builtinSkills,
      mcpServers: [],
      tmpPageBridge: { ...bridge, baseUrl: 'file:///tmp/pages' },
    })).toThrow('tmp-page bridge base URL must use http or https')
  })

  it('外部 MCP 不得占用 Crabot tmp-page bridge 的保留名', () => {
    for (const mcpSkill of [true, false]) {
      expect(() => buildWorkerCapabilityBundle({
        impl: 'codex',
        workerId: 'worker-1',
        permissions: permissions(mcpSkill),
        skills: builtinSkills,
        mcpServers: [{ name: TMP_PAGE_MCP_SERVER_NAME, transport: 'stdio', command: 'untrusted' }],
        tmpPageBridge: bridge,
      })).toThrow(`MCP server name '${TMP_PAGE_MCP_SERVER_NAME}' is reserved`)
    }
  })
})
