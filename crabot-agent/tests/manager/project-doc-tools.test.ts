import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { buildProjectDocTools } from '../../src/manager/tools/project-doc-tools.js'
import type { WakeEvent } from '../../src/manager/loop.js'
import type { ManagerKey } from '../../src/manager/types.js'
import type { ResolvedPermissions } from '../../src/types.js'
import type { WorkerContext } from '../../src/workers/harness/context-store.js'
import type { LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import type { LedgerStore } from '../../src/workers/harness/ledger-store.js'

const KEY = 'feishu::cotton-candy' as ManagerKey
const OTHER_KEY = 'feishu::other' as ManagerKey

function permissions(overrides: Partial<ResolvedPermissions> = {}): ResolvedPermissions {
  return {
    tool_access: {
      memory: false,
      messaging: false,
      task: false,
      mcp_skill: false,
      file_io: true,
      browser: false,
      shell: false,
      remote_exec: false,
      desktop: false,
    },
    cli_access: {
      provider: 'none', agent: 'none', mcp: 'none', skill: 'none', schedule: 'none',
      channel: 'none', friend: 'none', permission: 'none', config: 'none', undo: 'none',
    },
    storage: null,
    memory_scopes: [],
    ...overrides,
  }
}

function worker(workerId: string, managerKey: ManagerKey, workspace: string): LedgerWorker {
  return {
    worker_id: workerId,
    manager_key: managerKey,
    task: {
      id: workerId,
      title: `任务 ${workerId}`,
      status: 'running',
      created_at: '2026-09-04T00:00:00.000Z',
    },
    origin: { trigger_type: 'message' },
    report_to: { channel_id: 'feishu', session_id: 'cotton-candy' },
    incarnations: [{
      incarnation_id: `${workerId}-inc`,
      seq: 1,
      impl: 'builtin',
      state: 'running',
      workspace,
      session_ref: `${workerId}-session`,
      started_at: '2026-09-04T00:00:00.000Z',
    }],
    updated_at: '2026-09-04T00:00:00.000Z',
  }
}

function humanWake(perms?: ResolvedPermissions): WakeEvent {
  return {
    kind: 'human_messages',
    messages: [],
    ...(perms ? { principalPermissions: perms } : {}),
  }
}

function workerWake(workerId: string): WakeEvent {
  return {
    kind: 'worker_event',
    event: {
      ts: '2026-09-04T00:00:00.000Z',
      kind: 'turn_completed',
      worker_id: workerId,
      seq: 1,
    },
  }
}

describe('project document tools', () => {
  let root: string
  let project: string
  let sibling: string
  let workers: LedgerWorker[]
  let contexts: Map<string, WorkerContext>
  let ledger: LedgerStore

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'project-doc-tools-'))
    project = join(root, 'project')
    sibling = join(root, 'sibling')
    await fs.mkdir(join(project, 'docs'), { recursive: true })
    await fs.mkdir(sibling, { recursive: true })
    await fs.writeFile(join(project, 'README.md'), '# 项目\n入口说明\n')
    await fs.writeFile(join(project, 'docs', 'ARCHITECTURE.md'), '# 架构\n关键数据流\n')
    await fs.writeFile(join(project, 'notes.txt'), '不应列出')
    workers = [worker('w-project', KEY, project), worker('w-sibling', KEY, sibling)]
    contexts = new Map([
      ['w-project', { principal_permissions: permissions() }],
      ['w-sibling', { principal_permissions: permissions() }],
    ])
    ledger = {
      listWorkers: vi.fn(async (key: ManagerKey) => workers.filter((entry) => entry.manager_key === key)),
      findWorker: vi.fn(async (workerId: string) => {
        const found = workers.find((entry) => entry.worker_id === workerId)
        return found ? { managerKey: found.manager_key, worker: found } : undefined
      }),
    } as unknown as LedgerStore
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  function tools(wakeEvent: WakeEvent | undefined, managerPrincipalPermissions?: ResolvedPermissions) {
    return buildProjectDocTools({
      ledger,
      readWorkerContext: async (workerId) => contexts.get(workerId),
      managerKey: KEY,
      wakeEvent,
      ...(managerPrincipalPermissions ? { managerPrincipalPermissions } : {}),
    })
  }

  function tool(wakeEvent: WakeEvent | undefined, name: string, managerPrincipalPermissions?: ResolvedPermissions) {
    return tools(wakeEvent, managerPrincipalPermissions).find((entry) => entry.name === name)!
  }

  it('只暴露项目文档读取与决策写入两个工具，且没有 worker_id 参数', () => {
    const built = tools(humanWake(permissions()))
    expect(built.map((entry) => entry.name)).toEqual(['inspect_project_docs', 'manage_decision_doc'])
    expect(built[0].isReadOnly).toBe(true)
    expect(built[1].isReadOnly).toBe(false)
    expect(JSON.stringify(built.map((entry) => entry.inputSchema))).not.toContain('worker_id')
  })

  it('在 storage 授权根内列举、分段读取和字面搜索 Markdown', async () => {
    const wake = humanWake(permissions({ storage: { workspace_path: root, access: 'readwrite' } }))
    const inspect = tool(wake, 'inspect_project_docs')

    const listed = await inspect.call({ project_root: project, operation: 'list', page: 1, page_size: 1 }, {} as never)
    expect(listed.isError).toBe(false)
    expect(JSON.parse(listed.output)).toMatchObject({
      operation: 'list',
      items: [{ path: 'README.md', kind: 'file' }],
      pagination: { page: 1, page_size: 1, total_items: 2, total_pages: 2 },
    })

    const read = await inspect.call({
      project_root: project,
      operation: 'read',
      path: 'docs/ARCHITECTURE.md',
      start_line: 2,
      max_lines: 1,
    }, {} as never)
    expect(JSON.parse(read.output)).toMatchObject({
      operation: 'read',
      path: 'docs/ARCHITECTURE.md',
      start_line: 2,
      end_line: 2,
      total_lines: 2,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      content: '关键数据流',
    })

    const searched = await inspect.call({ project_root: project, operation: 'search', query: '数据流' }, {} as never)
    expect(JSON.parse(searched.output)).toEqual({
      operation: 'search',
      matches: [{ path: 'docs/ARCHITECTURE.md', line: 2, text: '关键数据流' }],
      truncated: false,
    })
  })

  it('无 file_io、缺权限快照和无主体系统唤醒均 fail-closed', async () => {
    const denied = [
      humanWake(permissions({ tool_access: { ...permissions().tool_access, file_io: false } })),
      humanWake(),
      { kind: 'media_notification', text: '系统通知' } as WakeEvent,
      undefined,
    ]
    for (const wake of denied) {
      const result = await tool(wake, 'inspect_project_docs').call({ project_root: project, operation: 'list' }, {} as never)
      expect(result.isError).toBe(true)
      expect(result.output).toMatch(/权限|主体|file_io/)
    }
  })

  it('独立任务板通知只可复用现有 Manager 主体权限，缺失时拒绝项目访问', async () => {
    const wake: WakeEvent = { kind: 'workboard_admin_update', noticeRevision: 1 }
    const granted = await tool(
      wake,
      'inspect_project_docs',
      permissions({ storage: { workspace_path: root, access: 'readwrite' } }),
    ).call({ project_root: project, operation: 'list' }, {} as never)
    expect(granted.isError).toBe(false)

    const denied = await tool(wake, 'inspect_project_docs').call({ project_root: project, operation: 'list' }, {} as never)
    expect(denied.isError).toBe(true)
    expect(denied.output).toContain('没有可用的主体权限快照')
  })

  it('storage 约束读取范围，read 档位不能写决策', async () => {
    const outside = humanWake(permissions({ storage: { workspace_path: sibling, access: 'readwrite' } }))
    expect((await tool(outside, 'inspect_project_docs').call({ project_root: project, operation: 'list' }, {} as never)).isError).toBe(true)

    const readOnly = humanWake(permissions({ storage: { workspace_path: project, access: 'read' } }))
    const result = await tool(readOnly, 'manage_decision_doc').call({
      project_root: project,
      action: 'create',
      file_name: '2026-09-04-read-only.md',
      content: '# 只读\n',
    }, {} as never)
    expect(result.isError).toBe(true)
    await expect(fs.access(join(project, 'docs', 'decisions', '2026-09-04-read-only.md'))).rejects.toThrow()
  })

  it('拒绝非规范化的 storage 与 Worker workspace 授权根', async () => {
    const nonCanonicalStorage = humanWake(permissions({
      storage: { workspace_path: `${root}/.`, access: 'readwrite' },
    }))
    expect((await tool(nonCanonicalStorage, 'inspect_project_docs').call({
      project_root: project,
      operation: 'list',
    }, {} as never)).isError).toBe(true)

    workers = [worker('w-project', KEY, `${project}/.`)]
    const noStorage = humanWake(permissions({ storage: null }))
    expect((await tool(noStorage, 'inspect_project_docs').call({
      project_root: project,
      operation: 'list',
    }, {} as never)).isError).toBe(true)
    expect((await tool(workerWake('w-project'), 'inspect_project_docs').call({
      project_root: project,
      operation: 'list',
    }, {} as never)).isError).toBe(true)
  })

  it('storage 为空时仅允许精确匹配当前 ManagerKey 已有 Worker workspace', async () => {
    const wake = humanWake(permissions({ storage: null }))
    expect((await tool(wake, 'inspect_project_docs').call({ project_root: project, operation: 'list' }, {} as never)).isError).toBe(false)
    expect((await tool(wake, 'inspect_project_docs').call({ project_root: join(project, 'docs'), operation: 'list' }, {} as never)).isError).toBe(true)

    workers = [worker('w-other', OTHER_KEY, sibling)]
    expect((await tool(wake, 'inspect_project_docs').call({ project_root: project, operation: 'list' }, {} as never)).isError).toBe(true)
  })

  it('Worker 事件只继承来源 Worker 的权限与自身 workspace', async () => {
    const wake = workerWake('w-project')
    expect((await tool(wake, 'inspect_project_docs').call({ project_root: project, operation: 'list' }, {} as never)).isError).toBe(false)
    expect((await tool(wake, 'inspect_project_docs').call({ project_root: sibling, operation: 'list' }, {} as never)).isError).toBe(true)

    contexts.set('w-project', {
      principal_permissions: permissions({ tool_access: { ...permissions().tool_access, file_io: false } }),
    })
    expect((await tool(wake, 'inspect_project_docs').call({ project_root: project, operation: 'list' }, {} as never)).isError).toBe(true)
  })

  it('拒绝路径逃逸、非 Markdown、生成目录和越界软链接', async () => {
    const wake = humanWake(permissions({ storage: { workspace_path: root, access: 'readwrite' } }))
    const inspect = tool(wake, 'inspect_project_docs')

    expect((await inspect.call({ project_root: project, operation: 'read', path: '../outside.md' }, {} as never)).isError).toBe(true)
    expect((await inspect.call({ project_root: project, operation: 'read', path: 'notes.txt' }, {} as never)).isError).toBe(true)
    expect((await inspect.call({ project_root: project, operation: 'list', path: 'dist' }, {} as never)).isError).toBe(true)

    await fs.writeFile(join(sibling, 'secret.md'), '# secret\n')
    await fs.symlink(join(sibling, 'secret.md'), join(project, 'escape.md'))
    expect((await inspect.call({ project_root: project, operation: 'read', path: 'escape.md' }, {} as never)).isError).toBe(true)

    await fs.mkdir(join(project, 'real-docs'))
    await fs.writeFile(join(project, 'real-docs', 'inside.md'), '# inside\n')
    await fs.symlink('real-docs', join(project, 'linked-docs'), 'dir')
    expect((await inspect.call({
      project_root: project,
      operation: 'read',
      path: 'linked-docs/inside.md',
    }, {} as never)).isError).toBe(true)
    expect((await inspect.call({
      project_root: project,
      operation: 'search',
      path: 'linked-docs',
      query: 'inside',
    }, {} as never)).isError).toBe(true)
  })

  it('默认和自定义决策目录都拒绝目录软链接且不写文件', async () => {
    const wake = humanWake(permissions({ storage: { workspace_path: root, access: 'readwrite' } }))
    const manage = tool(wake, 'manage_decision_doc')
    const linkedProject = join(root, 'linked-project')
    await fs.mkdir(join(linkedProject, 'real-docs'), { recursive: true })
    await fs.symlink('real-docs', join(linkedProject, 'docs'), 'dir')

    const defaultFile = '2026-09-04-default-link.md'
    expect((await manage.call({
      project_root: linkedProject,
      action: 'create',
      file_name: defaultFile,
      content: '# 默认目录软链接\n',
    }, {} as never)).isError).toBe(true)
    await expect(fs.access(join(linkedProject, 'real-docs', 'decisions', defaultFile))).rejects.toThrow()

    await fs.mkdir(join(project, 'real-adr'))
    await fs.symlink('real-adr', join(project, 'linked-adr'), 'dir')
    const customFile = '2026-09-04-custom-link.md'
    expect((await manage.call({
      project_root: project,
      action: 'create',
      decision_dir: 'linked-adr',
      file_name: customFile,
      content: '# 自定义目录软链接\n',
    }, {} as never)).isError).toBe(true)
    await expect(fs.access(join(project, 'real-adr', customFile))).rejects.toThrow()
  })

  it('read、list 和 search 的上限在工具边界生效', async () => {
    const wake = humanWake(permissions({ storage: { workspace_path: root, access: 'readwrite' } }))
    const inspect = tool(wake, 'inspect_project_docs')
    expect((await inspect.call({ project_root: project, operation: 'read', path: 'README.md', max_lines: 401 }, {} as never)).isError).toBe(true)
    expect((await inspect.call({ project_root: project, operation: 'list', page_size: 101 }, {} as never)).isError).toBe(true)
    expect((await inspect.call({ project_root: project, operation: 'search', query: '项目', limit: 51 }, {} as never)).isError).toBe(true)

    await fs.writeFile(join(project, 'too-large.md'), Buffer.alloc(1024 * 1024 + 1, 97))
    expect((await inspect.call({ project_root: project, operation: 'read', path: 'too-large.md' }, {} as never)).isError).toBe(true)
  })

  it('排他创建决策、基于 digest 更新，并拒绝并发覆盖', async () => {
    const wake = humanWake(permissions({ storage: { workspace_path: root, access: 'readwrite' } }))
    const manage = tool(wake, 'manage_decision_doc')
    const inspect = tool(wake, 'inspect_project_docs')
    const fileName = '2026-09-04-manager-context.md'

    const created = await manage.call({
      project_root: project,
      action: 'create',
      file_name: fileName,
      content: '# 主控上下文\n\n## 决策\n使用任务板。\n',
    }, {} as never)
    expect(created.isError).toBe(false)
    expect(JSON.parse(created.output)).toMatchObject({
      action: 'created',
      path: `docs/decisions/${fileName}`,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect((await manage.call({
      project_root: project,
      action: 'create',
      file_name: fileName,
      content: '# 重复\n',
    }, {} as never)).isError).toBe(true)

    const read = await inspect.call({ project_root: project, operation: 'read', path: `docs/decisions/${fileName}` }, {} as never)
    const digest = JSON.parse(read.output).digest as string
    expect((await manage.call({
      project_root: project,
      action: 'update',
      file_name: fileName,
      content: '# 主控上下文\n\n## 决策\n使用当前任务板。\n',
      expected_digest: '0'.repeat(64),
    }, {} as never)).isError).toBe(true)

    const updated = await manage.call({
      project_root: project,
      action: 'update',
      file_name: fileName,
      content: '# 主控上下文\n\n## 决策\n使用当前任务板。\n',
      expected_digest: digest,
    }, {} as never)
    expect(updated.isError).toBe(false)
    expect(JSON.parse(updated.output).digest).not.toBe(digest)
  })

  it('拒绝非法日期议题名、非默认缺失目录和无一级标题正文', async () => {
    const wake = humanWake(permissions({ storage: { workspace_path: root, access: 'readwrite' } }))
    const manage = tool(wake, 'manage_decision_doc')
    for (const fileName of ['2026-02-30-invalid.md', '2026-09-04-中文.md', '../2026-09-04-escape.md']) {
      expect((await manage.call({ project_root: project, action: 'create', file_name: fileName, content: '# 决策\n' }, {} as never)).isError).toBe(true)
    }
    expect((await manage.call({
      project_root: project,
      action: 'create',
      decision_dir: 'adr',
      file_name: '2026-09-04-missing-dir.md',
      content: '# 决策\n',
    }, {} as never)).isError).toBe(true)
    expect((await manage.call({
      project_root: project,
      action: 'create',
      file_name: '2026-09-04-no-heading.md',
      content: '没有一级标题',
    }, {} as never)).isError).toBe(true)
  })
})
