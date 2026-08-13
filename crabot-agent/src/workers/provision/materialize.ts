import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { buildChildEnv } from '../../core/runtime-env.js'
import { promisify } from 'node:util'

import type { MCPServerConfig } from '../../types.js'

const execFileAsync = promisify(execFile)

export interface ProvisionSources {
  skills: ReadonlyArray<{ id: string; name: string; skill_dir: string }>
  mcpServers: ReadonlyArray<MCPServerConfig>
  selfAwareness: { workerId: string; taskTitle: string; disciplines: string }
}

/**
 * skill.name 校验:非空、不含路径分隔符(`/`、`\`)、不是 `..`、不是 `.`,且 resolve 后
 * 必须是 targetRoot 的真子路径(不能等于 targetRoot 本身)。name 来自外部数据(skill 定义),
 * 未经校验直接拼进 fs.rm(recursive, force) 的目标路径会让恶意/畸形 name(如含 `/`、`..`)
 * 逃出 targetRoot、删掉 workspace 内甚至外的任意目录(P2 review #3)。`.` 是这条规则里
 * 容易漏掉的一种:不含 `/`、不等于 `..`,resolve(targetRoot, '.') 却恰好等于 targetRoot
 * 本身——旧校验只检查"逃出前缀",没检查"等于自身",会把 dest 算成 targetRoot,
 * fs.rm 直接清空整个 skills 目标目录(P2 复审 #4)。
 */
function validateSkillName(name: string, targetRoot: string): void {
  if (!name || name.includes('/') || name.includes('\\') || name === '..' || name === '.') {
    throw new Error(`materializeSkills: invalid skill.name ${JSON.stringify(name)} (must be non-empty, contain no path separators, and not be '.' or '..')`)
  }
  const resolvedRoot = path.resolve(targetRoot)
  const resolved = path.resolve(targetRoot, name)
  if (!resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`materializeSkills: skill.name ${JSON.stringify(name)} escapes target directory`)
  }
}

/**
 * 逐 skill 把 skill_dir 整目录复制到 <ws>/<targetSubdir>/<name>/。
 * 目标目录已存在时先整体清空再复制,保证与源目录结构一致(不残留源中已删除的旧文件)。
 */
export async function materializeSkills(
  ws: string,
  skills: ProvisionSources['skills'],
  targetSubdir: string
): Promise<void> {
  const targetRoot = path.join(ws, targetSubdir)
  for (const skill of skills) {
    validateSkillName(skill.name, targetRoot)
    const dest = path.join(targetRoot, skill.name)
    await fs.rm(dest, { recursive: true, force: true })
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.cp(skill.skill_dir, dest, { recursive: true })
  }
}

/** cc 标准 .mcp.json：stdio 保留 env；远端 server 显式 type，并保留认证 headers。 */
export function renderMcpJson(servers: ProvisionSources['mcpServers']): string {
  const mcpServers: Record<string, Record<string, unknown>> = {}
  for (const server of servers) {
    if (server.url !== undefined) {
      mcpServers[server.name] = {
        type: server.transport === 'sse' ? 'sse' : 'http',
        url: server.url,
        ...(server.headers !== undefined ? { headers: server.headers } : {}),
      }
    } else {
      const entry: Record<string, unknown> = { command: server.command }
      if (server.args !== undefined) entry.args = server.args
      if (server.env !== undefined) entry.env = server.env
      mcpServers[server.name] = entry
    }
  }
  return JSON.stringify({ mcpServers }, null, 2) + '\n'
}

function escapeTomlBasicString(value: string): string {
  let result = ''
  for (const ch of value) {
    if (ch === '\\') {
      result += '\\\\'
    } else if (ch === '"') {
      result += '\\"'
    } else {
      const code = ch.charCodeAt(0)
      if (code < 0x20 || code === 0x7f) {
        result += '\\u' + code.toString(16).padStart(4, '0')
      } else {
        result += ch
      }
    }
  }
  return result
}

function tomlString(value: string): string {
  return '"' + escapeTomlBasicString(value) + '"'
}

function tomlStringMap(values: Record<string, string>): string {
  return `{ ${Object.entries(values).map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`).join(', ')} }`
}

/** codex config.toml：stdio 保留 env；远端 server 保留认证 http_headers。 */
export function renderCodexMcpToml(servers: ProvisionSources['mcpServers']): string {
  const blocks = servers.map((server) => {
    const escapedName = escapeTomlBasicString(server.name)
    const lines = [`[mcp_servers."${escapedName}"]`]
    if (server.url !== undefined) {
      lines.push(`url = ${tomlString(server.url)}`)
      if (server.headers !== undefined) lines.push(`http_headers = ${tomlStringMap(server.headers)}`)
    } else {
      lines.push(`command = ${tomlString(server.command ?? '')}`)
      if (server.args !== undefined) {
        lines.push(`args = [${server.args.map(tomlString).join(', ')}]`)
      }
      if (server.env !== undefined) lines.push(`env = ${tomlStringMap(server.env)}`)
    }
    return lines.join('\n')
  })
  return blocks.length === 0 ? '' : blocks.join('\n\n') + '\n'
}

export async function assertWorkspaceFilesUntracked(
  workspaceRoot: string,
  relativePaths: readonly string[],
  caller: string,
): Promise<void> {
  const gitEnv = buildChildEnv({ LC_ALL: 'C' })
  let isGitWorkspace = false
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspaceRoot, 'rev-parse', '--is-inside-work-tree'], { env: gitEnv })
    isGitWorkspace = stdout.trim() === 'true'
  } catch (err) {
    const gitError = err as NodeJS.ErrnoException & { stderr?: string }
    if (gitError.code !== 'ENOENT' && !gitError.stderr?.includes('not a git repository')) {
      throw new Error(`${caller}: cannot inspect git workspace before writing credential files: ${gitError.message}`)
    }
  }
  if (!isGitWorkspace) return

  for (const relativePath of relativePaths) {
    try {
      await execFileAsync('git', ['-C', workspaceRoot, 'ls-files', '--error-unmatch', '--', relativePath], { env: gitEnv })
      throw new Error(
        `${caller}: refusing to overwrite tracked ${relativePath} with task-scoped credentials; ` +
        'untrack or relocate that file, then retry',
      )
    } catch (err) {
      const gitError = err as Error & { code?: string | number }
      if (gitError.message.startsWith(`${caller}:`)) throw err
      if (gitError.code !== 1) {
        throw new Error(`${caller}: cannot inspect ${relativePath} tracking state: ${gitError.message}`)
      }
    }
  }
}

export async function writeSensitiveFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${randomUUID()}`)
  try {
    await fs.writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o600 })
    await fs.chmod(tmpPath, 0o600)
    await fs.rename(tmpPath, filePath)
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined)
    throw err
  }
}

/** CLAUDE.md/AGENTS.md 正文:worker 身份声明 + 中间产物落盘纪律 + HANDOFF.md 交接约定。 */
export function renderContextMd(sa: ProvisionSources['selfAwareness']): string {
  return `# ${sa.taskTitle}

你是 crabot 的 worker(worker_id: ${sa.workerId}),当前工作区只服务于这一个任务。

## 中间产物落盘纪律

${sa.disciplines}

## 交接约定

任务中断或需要交接时,把当前进度、已完成的步骤、下一步计划写入工作区根目录的 \`HANDOFF.md\`,供恢复后的自己或接手的其他 worker 继续。
`
}
