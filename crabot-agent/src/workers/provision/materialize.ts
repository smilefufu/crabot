import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export interface ProvisionSources {
  skills: ReadonlyArray<{ id: string; name: string; skill_dir: string }>
  mcpServers: ReadonlyArray<{ name: string; transport: string; command?: string; args?: string[]; url?: string }>
  selfAwareness: { workerId: string; taskTitle: string; disciplines: string }
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
  for (const skill of skills) {
    const dest = path.join(ws, targetSubdir, skill.name)
    await fs.rm(dest, { recursive: true, force: true })
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.cp(skill.skill_dir, dest, { recursive: true })
  }
}

/** cc 标准 .mcp.json:stdio 用 command/args,http/sse 用 url。 */
export function renderMcpJson(servers: ProvisionSources['mcpServers']): string {
  const mcpServers: Record<string, Record<string, unknown>> = {}
  for (const s of servers) {
    if (s.url !== undefined) {
      mcpServers[s.name] = { url: s.url }
    } else {
      const entry: Record<string, unknown> = { command: s.command }
      if (s.args !== undefined) entry.args = s.args
      mcpServers[s.name] = entry
    }
  }
  return JSON.stringify({ mcpServers }, null, 2) + '\n'
}

function tomlString(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** codex config.toml 的 mcp_servers 段:stdio 用 command/args,http/sse 用 url。 */
export function renderCodexMcpToml(servers: ProvisionSources['mcpServers']): string {
  const blocks = servers.map((s) => {
    const lines = [`[mcp_servers.${s.name}]`]
    if (s.url !== undefined) {
      lines.push(`url = ${tomlString(s.url)}`)
    } else {
      lines.push(`command = ${tomlString(s.command ?? '')}`)
      if (s.args !== undefined) {
        lines.push(`args = [${s.args.map(tomlString).join(', ')}]`)
      }
    }
    return lines.join('\n')
  })
  return blocks.length === 0 ? '' : blocks.join('\n\n') + '\n'
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
