import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceGitInspector } from '../../../src/workers/harness/workspace-git-inspector.js'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})
const realExecFile = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).execFile
const exec = promisify(realExecFile)
const inspector = new WorkspaceGitInspector()
let root: string
let workspace: string

async function git(...args: string[]): Promise<string> {
  return (await exec('git', ['-C', workspace, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'Git Inspector Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Git Inspector Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
  })).stdout.trim()
}

async function init(): Promise<void> {
  await git('init', '-b', 'main')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', path.join(root, 'no-hooks'))
}

async function commit(file = 'source.txt', content = 'initial\n'): Promise<string> {
  await fs.writeFile(path.join(workspace, file), content)
  await git('add', '--', file)
  await git('commit', '-m', 'test change')
  return git('rev-parse', 'HEAD')
}

beforeEach(async () => {
  vi.mocked(execFile).mockImplementation(realExecFile)
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'workspace-git-test-')))
  workspace = path.join(root, 'project')
  await fs.mkdir(workspace)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

describe('WorkspaceGitInspector real Git', () => {
  it('distinguishes absent, unborn and newly initialized repositories without writing files', async () => {
    const absent = await inspector.inspect(workspace)
    expect(absent.current.state).toEqual({ status: 'not_repository' })
    expect(absent).toMatchObject({ comparison: 'unavailable', comparison_reason: 'baseline_missing' })
    expect(await fs.readdir(workspace)).toEqual([])
    expect((await inspector.inspect(workspace, absent.current)).comparison).toBe('not_repository')
    await init()
    const unborn = await inspector.inspect(workspace, absent.current)
    expect(unborn).toMatchObject({ comparison: 'repository_appeared', current: { state: {
      status: 'repository', head: null, branch: 'main', dirty: false, changes: [],
    } } })
    const head = await commit()
    expect(await inspector.inspect(workspace, unborn.current)).toMatchObject({
      comparison: 'advanced', commits: [head], commits_truncated: false,
    })
    expect(unborn.current.state).toMatchObject({ head: null })
  })

  it('retains staged and unstaged states, Unicode, newline paths and rename sources', async () => {
    await init()
    await commit('old name\n中文.txt')
    const baseline = (await inspector.inspect(workspace)).current
    await git('mv', '--', 'old name\n中文.txt', 'new name\n中文.txt')
    await fs.appendFile(path.join(workspace, 'new name\n中文.txt'), 'unstaged\n')
    await fs.writeFile(path.join(workspace, 'untracked\nfile'), 'new')
    const indexBefore = await fs.readFile(path.join(workspace, '.git/index'))
    const check = await inspector.inspect(workspace, baseline)
    expect(check).toMatchObject({ comparison: 'same_head', current: { state: {
      dirty: true, change_count: 2, unmerged_count: 0, changes_truncated: false,
      changes: [
        { path: 'new name\n中文.txt', previous_path: 'old name\n中文.txt', index_status: 'R', worktree_status: 'M' },
        { path: 'untracked\nfile', index_status: '?', worktree_status: '?' },
      ],
    } } })
    expect(await fs.readFile(path.join(workspace, '.git/index'))).toEqual(indexBefore)
  })

  it('restricts a parent repository to the workspace subtree and hides outside rename paths', async () => {
    await init()
    await fs.mkdir(path.join(workspace, 'child'))
    await commit('sibling-secret.txt')
    await git('mv', 'sibling-secret.txt', 'child/visible.txt')
    await fs.writeFile(path.join(workspace, 'other-secret.txt'), 'private')
    const check = await inspector.inspect(path.join(workspace, 'child'))
    expect(check.current.state).toMatchObject({ status: 'repository', repository_root: workspace,
      scope: 'subdirectory', dirty: true, change_count: 1, changes: [{ path: 'visible.txt' }] })
    expect(JSON.stringify(check)).not.toContain('secret.txt')
    await git('commit', '-m', 'move into workspace')
    await git('mv', 'child/visible.txt', 'outside-secret.txt')
    const outgoing = await inspector.inspect(path.join(workspace, 'child'))
    expect(outgoing.current.state).toMatchObject({ dirty: true, change_count: 1,
      changes: [{ path: 'visible.txt', index_status: 'D' }] })
    expect(JSON.stringify(outgoing)).not.toContain('secret.txt')
  })

  it('detects ignored workspaces and canonicalizes linked worktrees', async () => {
    await init()
    await commit('.gitignore', 'ignored/\n')
    const ignored = path.join(workspace, 'ignored')
    await fs.mkdir(ignored)
    await fs.writeFile(path.join(ignored, 'source.txt'), 'not protected')
    expect((await inspector.inspect(ignored)).current.state).toMatchObject({
      status: 'repository', workspace_ignored: true, dirty: false, scope: 'subdirectory',
    })
    const linked = path.join(root, 'linked\nworktree')
    await git('worktree', 'add', '-b', 'feature', linked)
    expect((await inspector.inspect(linked)).current.state).toMatchObject({
      status: 'repository', linked_worktree: true, repository_root: linked, branch: 'feature',
    })
  })

  it('compares full hashes without attributing author or task ownership, including detached HEAD', async () => {
    await init()
    const first = await commit()
    const baseline = (await inspector.inspect(workspace)).current
    const second = await commit('source.txt', 'second\n')
    expect(await inspector.inspect(workspace, baseline)).toMatchObject({ comparison: 'advanced', commits: [second] })
    await git('checkout', '--detach', first)
    expect(await inspector.inspect(workspace, baseline)).toMatchObject({
      comparison: 'same_head', current: { state: { branch: null, head: first } },
    })
    const atSecond = { ...baseline, state: { ...baseline.state, head: second } } as typeof baseline
    expect((await inspector.inspect(workspace, atSecond)).comparison).toBe('history_changed')
  })

  it('counts unresolved conflicts once and keeps index/worktree status characters', async () => {
    await init()
    await commit()
    await git('checkout', '-b', 'other')
    await commit('source.txt', 'other\n')
    await git('checkout', 'main')
    await commit('source.txt', 'main\n')
    await git('merge', 'other').catch(() => undefined)
    expect((await inspector.inspect(workspace)).current.state).toMatchObject({
      dirty: true, change_count: 1, unmerged_count: 1,
      changes: [{ path: 'source.txt', index_status: 'U', worktree_status: 'U' }],
    })
  })

  it('caps path lists without hiding the full dirty count', async () => {
    await init()
    for (let i = 0; i < 103; i++) await fs.writeFile(path.join(workspace, `file-${i}`), 'x')
    const check = await inspector.inspect(workspace)
    expect(check.current.state).toMatchObject({ dirty: true, change_count: 103, changes_truncated: true })
    if (check.current.state.status !== 'repository') throw new Error('expected repository')
    expect(check.current.state.changes).toHaveLength(100)
  })

  it('reports missing workspace and corrupt repository as errors, never as clean or absent', async () => {
    expect((await inspector.inspect(path.join(root, 'missing'))).current.state).toMatchObject({
      status: 'error', reason_code: 'workspace_unavailable',
    })
    await fs.mkdir(path.join(workspace, '.git'))
    expect((await inspector.inspect(workspace)).current.state).toMatchObject({
      status: 'error', reason_code: 'inspection_failed',
    })
  })

  it('cannot invoke executable fsmonitor and ignores inherited repository/index overrides', async () => {
    await init()
    await commit()
    const marker = path.join(root, 'fsmonitor-ran')
    await git('config', 'core.fsmonitor', `touch '${marker}'`)
    const original = process.env.GIT_DIR
    process.env.GIT_DIR = path.join(root, 'not-a-repo')
    try {
      expect((await inspector.inspect(workspace)).current.state).toMatchObject({ status: 'repository', head: expect.any(String) })
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (original === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = original
    }
  })

  it('does not fabricate comparison when old commit objects are unavailable', async () => {
    await init()
    await commit()
    const baseline = (await inspector.inspect(workspace)).current
    if (baseline.state.status !== 'repository') throw new Error('expected repository')
    baseline.state.head = 'f'.repeat(40)
    expect(await inspector.inspect(workspace, baseline)).toMatchObject({
      comparison: 'unavailable', comparison_reason: expect.any(String), commits: [],
      current: { state: { status: 'repository' } },
    })
  })

  it('reports shallow missing ancestry as unavailable and caps advanced commit lists', async () => {
    await init()
    await commit()
    const baseline = (await inspector.inspect(workspace)).current
    const tree = await git('rev-parse', 'HEAD^{tree}')
    let head = await git('rev-parse', 'HEAD')
    for (let i = 0; i < 102; i++) head = await git('commit-tree', tree, '-p', head, '-m', `change ${i}`)
    await git('update-ref', 'refs/heads/main', head)
    const advanced = await inspector.inspect(workspace, baseline)
    expect(advanced).toMatchObject({ comparison: 'advanced', commits_truncated: true })
    expect(advanced.commits).toHaveLength(100)
    const shallow = path.join(root, 'shallow')
    await git('clone', '--depth=1', `file://${workspace}`, shallow)
    if (baseline.state.status !== 'repository') throw new Error('expected repository')
    const shallowBaseline = { ...baseline, workspace_root: shallow, state: { ...baseline.state, repository_root: shallow } }
    expect(await inspector.inspect(shallow, shallowBaseline)).toMatchObject({
      comparison: 'unavailable', comparison_reason: expect.any(String), current: { state: { status: 'repository' } },
    })
  })

  it.each([
    ['ENOENT', '', 'git_unavailable'],
    ['EACCES', '', 'access_denied'],
    [128, 'fatal: detected dubious ownership in repository at private-secret', 'unsafe_repository'],
    [128, 'fatal: corrupt object private-secret', 'inspection_failed'],
  ])('classifies Git failure %s without exposing command diagnostics', async (code, stderr, reason) => {
    vi.mocked(execFile).mockImplementation(((_file, _args, _opts, callback) => {
      queueMicrotask(() => callback(Object.assign(new Error('private-secret'), { code }), Buffer.alloc(0), Buffer.from(stderr)))
      return { stdout: undefined, stderr: undefined }
    }) as typeof execFile)
    const result = await inspector.inspect(workspace)
    expect(result.current.state).toMatchObject({ status: 'error', reason_code: reason })
    expect(JSON.stringify(result)).not.toContain('private-secret')
  })

  it.each([
    ["process.stdout.write(Buffer.alloc(5 * 1024 * 1024, 65))", 'output_limit'],
    ["setTimeout(() => {}, 30000)", 'inspection_timeout'],
  ])('bounds the entire inspection and terminates the Git child: %s', async (script, reason) => {
    const original = realExecFile
    vi.mocked(execFile).mockImplementation(((_file, _args, opts, callback) =>
      original(process.execPath, ['-e', script], opts, callback)) as typeof execFile)
    const started = Date.now()
    const result = await inspector.inspect(workspace)
    expect(result.current.state).toMatchObject({ status: 'error', reason_code: reason })
    expect(Date.now() - started).toBeLessThan(6500)
  }, 8000)

  it('rejects a HEAD switch during sampling and preserves current facts on comparison failure', async () => {
    await init()
    await commit()
    const baseline = (await inspector.inspect(workspace)).current
    const original = realExecFile
    let heads = 0
    const spy = vi.mocked(execFile).mockImplementation(((file, args, opts, callback) => {
      return original(file, args, opts, (error, stdout, stderr) => {
        if ((args as string[]).includes('HEAD^{commit}') && ++heads === 2) {
          return callback(error, Buffer.from('f'.repeat(40) + '\n'), stderr)
        }
        callback(error, stdout, stderr)
      })
    }) as typeof execFile)
    expect((await inspector.inspect(workspace)).current.state).toMatchObject({ status: 'error', reason_code: 'changed_during_inspection' })
    spy.mockImplementation(realExecFile)
    await commit('source.txt', 'second')
    vi.mocked(execFile).mockImplementation(((file, args, opts, callback) => {
      if ((args as string[]).includes('merge-base')) {
        queueMicrotask(() => callback(Object.assign(new Error('comparison failed'), { code: 128 }), Buffer.alloc(0), Buffer.alloc(0)))
        return { stdout: undefined, stderr: undefined }
      }
      return original(file, args, opts, callback)
    }) as typeof execFile)
    expect(await inspector.inspect(workspace, baseline)).toMatchObject({
      comparison: 'unavailable', comparison_reason: 'inspection_failed', current: { state: { status: 'repository' } },
    })
  })
})
