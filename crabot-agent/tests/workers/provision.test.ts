import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  materializeSkills,
  renderMcpJson,
  renderCodexMcpToml,
  writeSensitiveFileAtomic,
  type ProvisionSources,
} from '../../src/workers/provision/materialize.js'

// 真实 builtin skill,作为 fixture 源(含 references/ 子目录),验证复制后结构完整
const FIXTURE_SKILL_DIR = path.resolve(__dirname, '../../../crabot-admin/builtins/skills/crabot-cli')

describe('materializeSkills', () => {
  let ws: string

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'provision-test-'))
  })

  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true })
  })

  it('把 skill_dir 整目录(含子目录)复制到 <ws>/<targetSubdir>/<name>/,按 name 而非 id 命名', async () => {
    const skills: ProvisionSources['skills'] = [
      { id: 'skill-id-xyz', name: 'crabot-cli', skill_dir: FIXTURE_SKILL_DIR },
    ]

    await materializeSkills(ws, skills, '.claude/skills')

    const destRoot = path.join(ws, '.claude/skills/crabot-cli')
    const [skillMd, refMd, srcSkillMd, srcRefMd] = await Promise.all([
      fs.readFile(path.join(destRoot, 'SKILL.md'), 'utf-8'),
      fs.readFile(path.join(destRoot, 'references/command-ref.md'), 'utf-8'),
      fs.readFile(path.join(FIXTURE_SKILL_DIR, 'SKILL.md'), 'utf-8'),
      fs.readFile(path.join(FIXTURE_SKILL_DIR, 'references/command-ref.md'), 'utf-8'),
    ])

    expect(skillMd).toBe(srcSkillMd)
    expect(refMd).toBe(srcRefMd)
  })

  it('目标目录已存在时整目录覆盖,清除源中不再存在的旧文件', async () => {
    const destRoot = path.join(ws, '.claude/skills/crabot-cli')
    await fs.mkdir(path.join(destRoot, 'references'), { recursive: true })
    await fs.writeFile(path.join(destRoot, 'stale.txt'), 'stale content')

    const skills: ProvisionSources['skills'] = [
      { id: 'crabot-cli', name: 'crabot-cli', skill_dir: FIXTURE_SKILL_DIR },
    ]
    await materializeSkills(ws, skills, '.claude/skills')

    await expect(fs.access(path.join(destRoot, 'stale.txt'))).rejects.toThrow()
    const skillMd = await fs.readFile(path.join(destRoot, 'SKILL.md'), 'utf-8')
    expect(skillMd.length).toBeGreaterThan(0)
  })

  it('支持一次物化多个 skill,各自落在独立子目录', async () => {
    const skills: ProvisionSources['skills'] = [
      { id: 'a', name: 'crabot-cli', skill_dir: FIXTURE_SKILL_DIR },
      { id: 'b', name: 'crabot-cli-copy', skill_dir: FIXTURE_SKILL_DIR },
    ]
    await materializeSkills(ws, skills, '.claude/skills')

    const names = (await fs.readdir(path.join(ws, '.claude/skills'))).sort()
    expect(names).toEqual(['crabot-cli', 'crabot-cli-copy'])
  })

  it('再次 provision 只清理上次由 Crabot 管理、但本次已不允许的 Skill', async () => {
    const targetRoot = path.join(ws, '.claude/skills')
    await fs.mkdir(path.join(targetRoot, 'native-user-skill'), { recursive: true })
    await fs.writeFile(path.join(targetRoot, 'native-user-skill/SKILL.md'), 'native')

    await materializeSkills(ws, [
      { id: 'a', name: 'crabot-cli', skill_dir: FIXTURE_SKILL_DIR },
      { id: 'b', name: 'crabot-cli-copy', skill_dir: FIXTURE_SKILL_DIR },
    ], '.claude/skills')
    await materializeSkills(ws, [
      { id: 'b', name: 'crabot-cli-copy', skill_dir: FIXTURE_SKILL_DIR },
    ], '.claude/skills')

    await expect(fs.access(path.join(targetRoot, 'crabot-cli'))).rejects.toThrow()
    await expect(fs.readFile(path.join(targetRoot, 'crabot-cli-copy/SKILL.md'), 'utf-8')).resolves.toBeTruthy()
    await expect(fs.readFile(path.join(targetRoot, 'native-user-skill/SKILL.md'), 'utf-8')).resolves.toBe('native')
  })

  // skill.name 未经校验就拼进 fs.rm(dest, {recursive, force}) 的目标路径——含 `/` 或 `..`
  // 的恶意/畸形 name 能让 dest 逃出 <ws>/.claude/skills/,递归删掉 workspace 内甚至外的任意
  // 目录(P2 review #3)。这里逐一验证每种恶意 name 都被 reject,且 reject 发生在任何
  // fs.rm/fs.cp 之前——已经物化好的哨兵文件必须原封不动。
  describe.each([['../../x'], ['a/b'], [''], ['..'], ['.']])('拒绝恶意 skill.name %j', (maliciousName) => {
    it(`reject 且不删除任何目录、不产生越权写入(name=${JSON.stringify(maliciousName)})`, async () => {
      const skillsDir = path.join(ws, '.claude/skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const sentinelPath = path.join(skillsDir, 'sentinel.txt')
      await fs.writeFile(sentinelPath, 'still here')

      const skills: ProvisionSources['skills'] = [{ id: 'x', name: maliciousName, skill_dir: FIXTURE_SKILL_DIR }]

      await expect(materializeSkills(ws, skills, '.claude/skills')).rejects.toThrow()

      // 哨兵文件原样还在——validateSkillName 在任何 fs.rm/fs.cp 之前就已经 throw。
      await expect(fs.readFile(sentinelPath, 'utf-8')).resolves.toBe('still here')
    })
  })
})

describe('writeSensitiveFileAtomic', () => {
  it('原子替换已有宽权限文件并把最终权限收紧到 0600', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provision-sensitive-'))
    const target = path.join(dir, '.mcp.json')
    try {
      await fs.writeFile(target, 'old', { mode: 0o644 })
      await writeSensitiveFileAtomic(target, 'new-secret')

      expect(await fs.readFile(target, 'utf-8')).toBe('new-secret')
      expect((await fs.stat(target)).mode & 0o777).toBe(0o600)
      expect((await fs.readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('renderMcpJson', () => {
  it('渲染 cc 标准 .mcp.json：stdio 用 command/args，远端显式 type/url', () => {
    const servers: ProvisionSources['mcpServers'] = [
      { name: 'crabot', transport: 'stdio', command: 'node', args: ['mcp-server.js'] },
      { name: 'remote', transport: 'streamable-http', url: 'https://example.com/mcp' },
    ]

    expect(renderMcpJson(servers)).toBe(`{
  "mcpServers": {
    "crabot": {
      "command": "node",
      "args": [
        "mcp-server.js"
      ]
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp"
    }
  }
}
`)
  })

  it('保留 stdio env、远端 headers，并区分 http/sse type', () => {
    const rendered = JSON.parse(renderMcpJson([
      { name: 'stdio-auth', transport: 'stdio', command: 'node', env: { API_KEY: 'secret' } },
      { name: 'http-auth', transport: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer token' } },
      { name: 'sse-auth', transport: 'sse', url: 'https://example.com/sse', headers: { 'X-Key': 'value' } },
    ]))

    expect(rendered.mcpServers).toEqual({
      'stdio-auth': { command: 'node', env: { API_KEY: 'secret' } },
      'http-auth': { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer token' } },
      'sse-auth': { type: 'sse', url: 'https://example.com/sse', headers: { 'X-Key': 'value' } },
    })
  })

  it('stdio server 无 args 时省略 args 字段', () => {
    const servers: ProvisionSources['mcpServers'] = [{ name: 'bare', transport: 'stdio', command: 'crabot-mcp' }]

    expect(renderMcpJson(servers)).toBe(`{
  "mcpServers": {
    "bare": {
      "command": "crabot-mcp"
    }
  }
}
`)
  })

  it('空 server 列表渲染出空 mcpServers 对象', () => {
    expect(renderMcpJson([])).toBe(`{
  "mcpServers": {}
}
`)
  })
})

describe('renderCodexMcpToml', () => {
  it('渲染 codex config.toml 的 mcp_servers 段：stdio 用 command/args，远端用 url', () => {
    const servers: ProvisionSources['mcpServers'] = [
      { name: 'crabot', transport: 'stdio', command: 'node', args: ['mcp-server.js', '--flag'] },
      { name: 'remote', transport: 'streamable-http', url: 'https://example.com/mcp' },
    ]

    expect(renderCodexMcpToml(servers)).toBe(`[mcp_servers."crabot"]
command = "node"
args = ["mcp-server.js", "--flag"]

[mcp_servers."remote"]
url = "https://example.com/mcp"
`)
  })

  it('保留 stdio env 与远端 http_headers，并正确转义键值', () => {
    const servers: ProvisionSources['mcpServers'] = [
      { name: 'stdio-auth', transport: 'stdio', command: 'node', env: { API_KEY: 'a"b\\c' } },
      { name: 'http-auth', transport: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer "token"' } },
    ]

    expect(renderCodexMcpToml(servers)).toBe(`[mcp_servers."stdio-auth"]
command = "node"
env = { "API_KEY" = "a\\"b\\\\c" }

[mcp_servers."http-auth"]
url = "https://example.com/mcp"
http_headers = { "Authorization" = "Bearer \\"token\\"" }
`)
  })

  it('command 中含引号和反斜杠时正确转义为 TOML 字符串', () => {
    const servers: ProvisionSources['mcpServers'] = [
      { name: 'weird', transport: 'stdio', command: 'C:\\bin\\"crabot".exe' },
    ]

    expect(renderCodexMcpToml(servers)).toBe(`[mcp_servers."weird"]
command = "C:\\\\bin\\\\\\"crabot\\".exe"
`)
  })

  it('server name 含点号时用 quoted key 正确表示', () => {
    const servers: ProvisionSources['mcpServers'] = [
      { name: 'my.server', transport: 'stdio', command: 'cmd' },
    ]

    const output = renderCodexMcpToml(servers)
    expect(output).toContain('[mcp_servers."my.server"]')
    expect(output).toContain('command = "cmd"')
  })

  it('server name 含空格时用 quoted key 正确表示', () => {
    const servers: ProvisionSources['mcpServers'] = [
      { name: 'my server', transport: 'stdio', command: 'cmd' },
    ]

    const output = renderCodexMcpToml(servers)
    expect(output).toContain('[mcp_servers."my server"]')
    expect(output).toContain('command = "cmd"')
  })

  it('server name 含双引号时正确转义', () => {
    const servers: ProvisionSources['mcpServers'] = [
      { name: 'server"test', transport: 'stdio', command: 'cmd' },
    ]

    const output = renderCodexMcpToml(servers)
    expect(output).toContain('[mcp_servers."server\\"test"]')
    expect(output).toContain('command = "cmd"')
  })

  it('server name 含反斜杠时正确转义', () => {
    const servers: ProvisionSources['mcpServers'] = [
      { name: 'server\\test', transport: 'stdio', command: 'cmd' },
    ]

    const output = renderCodexMcpToml(servers)
    expect(output).toContain('[mcp_servers."server\\\\test"]')
    expect(output).toContain('command = "cmd"')
  })

  it('server name 含中文时用 quoted key 正确表示', () => {
    const servers: ProvisionSources['mcpServers'] = [
      { name: '服务器', transport: 'stdio', command: 'cmd' },
    ]

    const output = renderCodexMcpToml(servers)
    expect(output).toContain('[mcp_servers."服务器"]')
    expect(output).toContain('command = "cmd"')
  })

  it('server name 仅含允许的字符时也统一使用 quoted key 形式', () => {
    const servers: ProvisionSources['mcpServers'] = [
      { name: 'simple_name-v2', transport: 'stdio', command: 'cmd' },
    ]

    const output = renderCodexMcpToml(servers)
    expect(output).toContain('[mcp_servers."simple_name-v2"]')
    expect(output).toContain('command = "cmd"')
  })

  it('空 server 列表渲染为空字符串', () => {
    expect(renderCodexMcpToml([])).toBe('')
  })
})
