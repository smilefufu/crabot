import fs from 'node:fs/promises'
import path from 'node:path'
import { WorkspaceError } from './workspace-catalog.js'

const unavailable = () => new WorkspaceError('WORKSPACE_MOUNTS_UNAVAILABLE', '无法核实工作区的挂载边界，未发布不完整的成功统计。')
const within = (parent: string, child: string) => { const relative = path.relative(parent, child); return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) }

/** Kernel mountinfo field 5; spaces/tabs/newlines/backslashes use octal escapes. Optional fields have no fixed count. */
export function parseLinuxMounts(text: string): Map<string, string> {
  if (!text.trim() || text.length > 16 * 1024 * 1024) throw unavailable()
  const mounts = new Map<string, string>()
  for (const line of text.trimEnd().split('\n')) {
    const fields = line.split(' '), separator = fields.indexOf('-')
    if (separator < 6 || fields.length < separator + 4 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1])
      || !/^\d+:\d+$/.test(fields[2]) || fields[4].replace(/\\[0-7]{3}/g, '').includes('\\')) throw unavailable()
    const point = fields[4].replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)))
    if (!path.posix.isAbsolute(point) || point.includes('\0')) throw unavailable()
    mounts.set(point, (mounts.get(point) ?? '') + line + '\n')
  }
  return mounts
}

export async function workspaceMountBoundary(roots: readonly string[]): Promise<{ points: Set<string>; signature: string }> {
  if (process.platform !== 'linux') return { points: new Set(), signature: '' }
  let mounts: Map<string, string>
  try { mounts = parseLinuxMounts(await fs.readFile('/proc/self/mountinfo', 'utf8')) } catch { throw unavailable() }
  const relevant = [...mounts].filter(([point]) => roots.some(root => within(root, point) || within(point, root))).sort(([a], [b]) => a.localeCompare(b))
  return { points: new Set(relevant.map(([point]) => point)), signature: relevant.map(([, value]) => value).join('') }
}
