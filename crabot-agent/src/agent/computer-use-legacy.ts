import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { LedgerWorker } from '../workers/harness/ledger-types.js'

interface ProcessRow { pid: number; ppid: number; command: string }
function run(command: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => execFile(command, args, { timeout: 3_000, maxBuffer: 8 * 1024 * 1024 }, (error, output) => error ? fail(error) : done(output)))
}
async function processes(): Promise<ProcessRow[]> {
  return (await run('ps', ['-axo', 'pid=,ppid=,stat=,command='])).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line)
    return match && !match[3].startsWith('Z') ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[4] }] : []
  })
}
function descendant(pid: number, roots: ReadonlySet<number>, rows: ReadonlyArray<ProcessRow>): boolean {
  const seen = new Set<number>()
  while (pid > 0 && !seen.has(pid)) {
    if (roots.has(pid)) return true
    seen.add(pid); pid = rows.find(row => row.pid === pid)?.ppid ?? 0
  }
  return false
}

/** Retire only legacy stdio children rooted in proven Crabot Worker panes; no task state changes. */
export async function retireOwnedLegacyComputerUse(roots: ReadonlySet<number>, launchers: ReadonlySet<string>): Promise<number> {
  const rows = await processes()
  const legacy = rows.filter(row => [...launchers].some(launcher => row.command.endsWith(` ${launcher}`))
    && descendant(row.ppid, roots, rows))
  const selected = rows.filter(row => descendant(row.pid, new Set(legacy.map(item => item.pid)), rows)).reverse()
  for (const row of selected) {
    const current = (await processes()).find(item => item.pid === row.pid)
    if (!current) continue
    if (current.ppid !== row.ppid || current.command !== row.command) throw new Error('COMPUTER_USE_LEGACY_OWNERSHIP_CHANGED')
    process.kill(row.pid, 'SIGTERM')
  }
  await new Promise(done => setTimeout(done, 100))
  for (const row of selected) {
    const current = (await processes()).find(item => item.pid === row.pid)
    if (!current) continue
    if (current.ppid !== row.ppid || current.command !== row.command) throw new Error('COMPUTER_USE_LEGACY_OWNERSHIP_CHANGED')
    process.kill(row.pid, 'SIGKILL')
  }
  for (let i = 0; i < 40; i++) {
    const remaining = await processes()
    if (!selected.some(row => remaining.some(item => item.pid === row.pid && item.command === row.command))) return legacy.length
    await new Promise(done => setTimeout(done, 50))
  }
  throw new Error('COMPUTER_USE_LEGACY_STOP_UNCONFIRMED')
}

export async function retireLegacyWorkerComputerUse(workers: ReadonlyArray<LedgerWorker>, agentLaunchers: ReadonlyArray<string> = []): Promise<void> {
  if (process.platform !== 'darwin') return // The replaced legacy backend could input only on macOS.
  const sessions = new Set<string>()
  const launchers = new Set<string>(agentLaunchers)
  const nativeSessions = new Set<string>()
  for (const worker of workers) for (const incarnation of worker.incarnations) {
    if (incarnation.impl !== 'claude-code' && incarnation.impl !== 'codex') continue
    sessions.add(`crabot-w-${worker.worker_id}-${incarnation.seq}`)
    if ('session_ref' in incarnation && /^[A-Za-z0-9-]{8,}$/.test(incarnation.session_ref)) nativeSessions.add(incarnation.session_ref)
    for (const name of ['.mcp.json', '.codex/config.toml']) {
      try {
        const source = await fs.readFile(path.join(incarnation.workspace, name), 'utf8')
        const config = name.endsWith('.json') ? JSON.parse(source) : parseToml(source)
        const entry = (config.mcpServers ?? config.mcp_servers)?.['computer-use']
        if (entry?.command === 'node' && Array.isArray(entry.args) && entry.args.length === 1
          && Object.keys(entry.env ?? {}).length === 0 && entry.args[0].replace(/\\/g, '/').endsWith('/crabot-mcp-tools/dist/computer-use/main.js')) launchers.add(entry.args[0])
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
  if (!launchers.size) return
  const panes = await run('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}']).catch(error => {
    if (error.code === 1 || error.code === 'ENOENT') return ''; throw error
  })
  const roots = new Set<number>(agentLaunchers.length ? [process.pid] : [])
  for (const pid of panes.split('\n').flatMap(line => {
    const [session, pid] = line.split('\t')
    return sessions.has(session) && /^\d+$/.test(pid) ? [Number(pid)] : []
  })) roots.add(pid)
  for (const row of await processes()) {
    if (!/(^|[ /])(?:claude|codex)(?:[ .]|$)/.test(row.command)) continue
    if ([...nativeSessions].some(id => new RegExp(`(?:--resume|--session-id)\\s+['"]?${id}(?:['"]?\\s|$)`).test(row.command))) roots.add(row.pid)
  }
  if (roots.size) await retireOwnedLegacyComputerUse(roots, launchers)
}
