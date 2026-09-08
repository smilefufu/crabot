import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { WorkspaceGitChange, WorkspaceGitCheck, WorkspaceGitObservation, WorkspaceGitState } from '../types.js'

const TIMEOUT_MS = 5_000
const OUTPUT_LIMIT = 4 * 1024 * 1024
const LIST_LIMIT = 100
type GitErrorCode = Extract<WorkspaceGitState, { status: 'error' }>['reason_code']
type RepositoryState = Extract<WorkspaceGitState, { status: 'repository' }>

class InspectionError extends Error {
  constructor(readonly reason: GitErrorCode) { super(reason) }
}

class GitCommandError extends Error {
  constructor(readonly exitCode: number, readonly stderr: string) { super('Git command failed') }
}

function errorCode(error: unknown): GitErrorCode {
  if (error instanceof InspectionError) return error.reason
  if (error instanceof GitCommandError) {
    if (error.stderr.includes('detected dubious ownership')) return 'unsafe_repository'
    if (/Permission denied|Operation not permitted/i.test(error.stderr)) return 'access_denied'
  }
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'EACCES' || code === 'EPERM') return 'access_denied'
  return 'inspection_failed'
}

const ERROR_MESSAGES: Record<GitErrorCode, string> = {
  git_unavailable: 'Git executable is unavailable',
  workspace_unavailable: 'Workspace directory is unavailable',
  access_denied: 'Workspace Git inspection is not authorized or readable',
  unsafe_repository: 'Git rejected the repository ownership',
  inspection_failed: 'Git inspection failed; repository state is unknown',
  inspection_timeout: 'Git inspection exceeded its time limit',
  output_limit: 'Git inspection exceeded its output limit',
  changed_during_inspection: 'Repository identity or HEAD changed during inspection',
}

export function workspaceGitError(workspaceRoot: string, reason: GitErrorCode): WorkspaceGitObservation {
  return { captured_at: new Date().toISOString(), workspace_root: path.resolve(workspaceRoot),
    state: { status: 'error', reason_code: reason, message: ERROR_MESSAGES[reason] } }
}

function unavailable(current: WorkspaceGitObservation, baseline: WorkspaceGitObservation | undefined, reason: string): WorkspaceGitCheck {
  return { current, ...(baseline ? { baseline } : {}), comparison: 'unavailable', comparison_reason: reason,
    commits: [], commits_truncated: false }
}

interface RepositoryIdentity {
  root: string
  gitDir: string
  commonDir: string
  head: string | null
  branch: string | null
}

// Each call owns one deadline and output budget, including discovery and history comparison.
class GitInspection {
  private outputBytes = 0
  current?: WorkspaceGitObservation

  constructor(readonly workspace: string, readonly requestedWorkspace: string,
    readonly abort: AbortController, readonly deadline: number) {}

  async run(cwd: string, args: string[], allowed = [0]): Promise<{ text: string; code: number }> {
    if (this.abort.signal.aborted || Date.now() >= this.deadline) throw new InspectionError('inspection_timeout')
    if (this.outputBytes >= OUTPUT_LIMIT) throw new InspectionError('output_limit')
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
    Object.assign(env, { LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' })
    return new Promise((resolve, reject) => {
      let exceeded = false
      const child = execFile('git', [
        '--no-optional-locks', '--no-replace-objects', ...(args[0] === 'status' ? ['--literal-pathspecs'] : []),
        '-c', 'core.fsmonitor=false', '-c', 'status.relativePaths=false',
        '-c', 'protocol.allow=never', '-C', cwd, ...args,
      ], {
        env, encoding: 'buffer', signal: this.abort.signal,
        timeout: Math.max(1, this.deadline - Date.now()), killSignal: 'SIGKILL',
        maxBuffer: OUTPUT_LIMIT - this.outputBytes,
      }, (error, stdout, stderr) => {
        if (exceeded || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new InspectionError('output_limit'))
        if (this.abort.signal.aborted || error?.killed) return reject(new InspectionError('inspection_timeout'))
        if (error?.code === 'ENOENT') return reject(new InspectionError('git_unavailable'))
        if (error && typeof error.code !== 'number') return reject(error)
        const code = typeof error?.code === 'number' ? error.code : 0
        if (!allowed.includes(code)) return reject(new GitCommandError(code, stderr.toString('utf8')))
        resolve({ text: stdout.toString('utf8'), code })
      })
      const count = (chunk: Buffer): void => {
        this.outputBytes += chunk.length
        if (this.outputBytes > OUTPUT_LIMIT) { exceeded = true; child.kill('SIGKILL') }
      }
      child.stdout?.on('data', count)
      child.stderr?.on('data', count)
    })
  }

  async identity(): Promise<RepositoryIdentity | undefined> {
    let root: string
    try {
      root = (await this.run(this.workspace, ['rev-parse', '--show-toplevel'])).text.replace(/\n$/, '')
    } catch (error) {
      if (!(error instanceof GitCommandError) || !/^fatal: not a git repository \(or any /m.test(error.stderr)) throw error
      // Git ignores malformed .git directories during discovery. Do not call those a new project.
      for (let dir = this.workspace; ; dir = path.dirname(dir)) {
        try {
          await fs.lstat(path.join(dir, '.git'))
          throw new InspectionError('inspection_failed')
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError
        }
        if (path.dirname(dir) === dir) break
      }
      return undefined
    }
    root = await fs.realpath(root)
    const gitDir = await fs.realpath((await this.run(this.workspace, ['rev-parse', '--absolute-git-dir'])).text.replace(/\n$/, ''))
    const commonDir = await fs.realpath((await this.run(this.workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).text.replace(/\n$/, ''))
    const branchRef = await this.run(this.workspace, ['symbolic-ref', '--quiet', 'HEAD'], [0, 1])
    const ref = branchRef.code === 0 ? branchRef.text.replace(/\n$/, '') : null
    const headResult = await this.run(this.workspace, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], [0, 1])
    const head = headResult.code === 0 ? headResult.text.trim() : null
    if (head === null) {
      if (!ref || (await this.run(this.workspace, ['show-ref', '--verify', '--quiet', ref], [0, 1])).code !== 1) {
        throw new InspectionError('inspection_failed')
      }
    }
    return { root, gitDir, commonDir, head, branch: ref?.replace(/^refs\/heads\//, '') ?? null }
  }

  async check(baseline?: WorkspaceGitObservation): Promise<WorkspaceGitCheck> {
    const before = await this.identity()
    let state: WorkspaceGitState = { status: 'not_repository' }
    if (before) {
      const prefix = path.relative(before.root, this.workspace).split(path.sep).join('/')
      const status = await this.run(before.root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', prefix || '.'])
      const parsed = parseStatus(status.text, prefix)
      const ignored = await this.run(this.workspace, ['check-ignore', '--quiet', '--', '.'], [0, 1])
      state = { status: 'repository', repository_root: before.root,
        scope: prefix ? 'subdirectory' : 'repository', linked_worktree: before.gitDir !== before.commonDir,
        workspace_ignored: ignored.code === 0, head: before.head, branch: before.branch,
        dirty: parsed.change_count > 0, ...parsed }
    }
    await this.assertUnchanged(before)
    this.current = { captured_at: new Date().toISOString(), workspace_root: this.workspace, state }
    const result = await this.compare(baseline)
    if (before && baseline?.state.status === 'repository') await this.assertUnchanged(before)
    return result
  }

  private async assertUnchanged(before: RepositoryIdentity | undefined): Promise<void> {
    if (await fs.realpath(this.requestedWorkspace) !== this.workspace || JSON.stringify(await this.identity()) !== JSON.stringify(before)) {
      throw new InspectionError('changed_during_inspection')
    }
  }

  private async compare(baseline?: WorkspaceGitObservation): Promise<WorkspaceGitCheck> {
    const current = this.current!
    const state = current.state
    if (!baseline) return unavailable(current, baseline, 'baseline_missing')
    if (baseline.state.status === 'error') return unavailable(current, baseline, 'baseline_failed')
    const result: WorkspaceGitCheck = { current, baseline, comparison: 'same_head', commits: [], commits_truncated: false }
    if (baseline.workspace_root !== current.workspace_root) return { ...result, comparison: 'repository_changed' }
    if (baseline.state.status === 'not_repository') {
      return { ...result, comparison: state.status === 'not_repository' ? 'not_repository' : 'repository_appeared' }
    }
    if (state.status !== 'repository' || baseline.state.repository_root !== state.repository_root
      || baseline.state.linked_worktree !== state.linked_worktree || baseline.state.scope !== state.scope) {
      return { ...result, comparison: 'repository_changed' }
    }
    const oldHead = baseline.state.head
    if (oldHead === state.head) return result
    if (oldHead) await this.run(state.repository_root, ['cat-file', '-e', `${oldHead}^{commit}`])
    if (!state.head) return { ...result, comparison: 'history_changed' }
    const shallow = (await this.run(state.repository_root, ['rev-parse', '--is-shallow-repository'])).text.trim() === 'true'
    const ancestor = oldHead
      ? (await this.run(state.repository_root, ['merge-base', '--is-ancestor', oldHead, state.head], [0, 1])).code === 0
      : true
    if (shallow && (!ancestor || !oldHead)) return unavailable(current, baseline, 'shallow_history_incomplete')
    if (!ancestor) return { ...result, comparison: 'history_changed' }
    const commits = (await this.run(state.repository_root, [
      'rev-list', `--max-count=${LIST_LIMIT + 1}`, state.head, ...(oldHead ? [`^${oldHead}`] : []), '--',
    ])).text.trim().split('\n').filter(Boolean)
    return { ...result, comparison: 'advanced', commits: commits.slice(0, LIST_LIMIT),
      commits_truncated: commits.length > LIST_LIMIT || shallow }
  }
}

function statusFields(record: string, fieldCount: number): { fields: string[]; file: string } {
  const fields: string[] = []
  let offset = 0
  for (let i = 0; i < fieldCount; i++) {
    const next = record.indexOf(' ', offset)
    if (next < 0) throw new InspectionError('inspection_failed')
    fields.push(record.slice(offset, next))
    offset = next + 1
  }
  const file = record.slice(offset)
  if (!file || fields[1]?.length !== 2) throw new InspectionError('inspection_failed')
  return { fields, file }
}

function relativeStatusPath(file: string, prefix: string): string | undefined {
  if (file.startsWith('/') || file.split('/').includes('..')) throw new InspectionError('inspection_failed')
  return prefix ? (file.startsWith(`${prefix}/`) ? file.slice(prefix.length + 1) : undefined) : file
}

function parseStatus(text: string, prefix: string): Pick<RepositoryState, 'change_count' | 'unmerged_count' | 'changes' | 'changes_truncated'> {
  const changes: WorkspaceGitChange[] = []
  let count = 0
  let unmerged = 0
  const records = text.split('\0')
  if (records.pop() !== '') throw new InspectionError('inspection_failed')
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    let file: string
    let xy: string
    let previous: string | undefined
    if (record.startsWith('? ')) { file = record.slice(2); xy = '??' }
    else if (record.startsWith('1 ') || record.startsWith('2 ') || record.startsWith('u ')) {
      const parsed = statusFields(record, record[0] === '1' ? 8 : record[0] === '2' ? 9 : 10)
      file = parsed.file
      xy = parsed.fields[1]
      if (record[0] === '2') {
        const source = records[++i]
        if (!source) throw new InspectionError('inspection_failed')
        if (xy.includes('R')) previous = relativeStatusPath(source, prefix)
      }
    } else throw new InspectionError('inspection_failed')
    const relative = relativeStatusPath(file, prefix)
    if (relative === undefined) continue
    count++
    if (record[0] === 'u') unmerged++
    if (changes.length < LIST_LIMIT) changes.push({ path: relative, ...(previous ? { previous_path: previous } : {}),
      index_status: xy[0], worktree_status: xy[1] })
  }
  return { change_count: count, unmerged_count: unmerged, changes, changes_truncated: count > LIST_LIMIT }
}

/** Harness-owned read-only implementation shared by automatic sampling and both tool transports. */
export class WorkspaceGitInspector {
  async inspect(workspaceRoot: string, baseline?: WorkspaceGitObservation): Promise<WorkspaceGitCheck> {
    let operation: GitInspection | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = new AbortController()
    const deadline = Date.now() + TIMEOUT_MS
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new InspectionError('inspection_timeout')) }, TIMEOUT_MS)
    })
    try {
      return await Promise.race([timeout, (async () => {
        let workspace: string
        try {
          workspace = await fs.realpath(workspaceRoot)
          if (!(await fs.stat(workspace)).isDirectory()) throw new InspectionError('workspace_unavailable')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new InspectionError('workspace_unavailable')
          throw error
        }
        operation = new GitInspection(workspace, workspaceRoot, abort, deadline)
        return operation.check(baseline)
      })()])
    } catch (error) {
      const reason = errorCode(error)
      const current = reason !== 'changed_during_inspection' && operation?.current
        ? operation.current : workspaceGitError(operation?.workspace ?? workspaceRoot, reason)
      return unavailable(current, baseline, reason)
    } finally {
      clearTimeout(timer)
      abort.abort()
    }
  }
}

export function appendWorkspaceGitObservation(text: string, observation: WorkspaceGitObservation): string {
  return `${text}\n\n<workspace-git-observation>\n${JSON.stringify(observation)}\n</workspace-git-observation>`
}

export function summarizeWorkspaceGit(check: WorkspaceGitCheck): Record<string, unknown> {
  const state = check.current.state
  return { captured_at: check.current.captured_at, status: state.status,
    comparison: check.comparison, commits: check.commits, commits_truncated: check.commits_truncated,
    ...(check.comparison_reason ? { comparison_reason: check.comparison_reason } : {}),
    ...(state.status === 'repository' ? { head: state.head, dirty: state.dirty, change_count: state.change_count,
      unmerged_count: state.unmerged_count, changes_truncated: state.changes_truncated } : {}),
    ...(state.status === 'error' ? { reason_code: state.reason_code, message: state.message } : {}),
  }
}
