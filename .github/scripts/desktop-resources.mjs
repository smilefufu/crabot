// One CI observation of the product process trees. RSS sums count shared pages
// more than once; this is not unique physical memory or a lifecycle authority.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import identity from '../../scripts/lib/process-identity.cjs'
const execute = promisify(execFile)
export async function observeDesktopResources(roots) {
  const self = identity.inspectProcess(process.pid)
  if (!roots.length || roots.some(root => !root || root.owner !== self.owner || !identity.sameProcess(root, identity.inspectProcess(root.pid)))) throw new Error('Resource sample roots changed')
  const observed = new Map(roots.map(root => [root.pid, root])), candidates = []
  for (const pid of identity.listProcessIds()) {
    try { const current = identity.inspectProcess(pid); if (current?.owner === self.owner) candidates.push(current) } catch {}
  }
  for (let changed = true; changed;) {
    changed = false
    for (const current of candidates) if (!observed.has(current.pid) && observed.has(current.parent)) { observed.set(current.pid, current); changed = true }
  }
  const pids = [...observed.keys()]
  let rows
  if (process.platform === 'win32') {
    const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const script = 'Get-Process -Id @(' + pids.join(',') + ') -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64 | ConvertTo-Json -Compress'
    const { stdout } = await execute(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15_000, maxBuffer: 65536 })
    const value = JSON.parse(stdout); rows = (Array.isArray(value) ? value : [value]).map(row => [row.Id, row.WorkingSet64])
  } else {
    const { stdout } = await execute('/bin/ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], { timeout: 15_000, maxBuffer: 65536 })
    rows = stdout.trim().split(/\r?\n/).map(line => { const [pid, kib] = line.trim().split(/\s+/).map(Number); return [pid, kib * 1024] })
  }
  let rss = 0, sampled = 0
  const seen = new Set()
  for (const [pid, bytes] of rows) {
    const expected = observed.get(pid)
    if (!expected || seen.has(pid) || !Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('Invalid OS resource sample')
    seen.add(pid)
    if (!identity.sameProcess(expected, identity.inspectProcess(pid))) continue
    rss += bytes; sampled++
  }
  if (roots.some(root => !identity.sameProcess(root, identity.inspectProcess(root.pid)))) throw new Error('Resource sample roots changed')
  return { platform: process.platform, arch: process.arch, os_release: os.release(), logical_cpus: os.cpus().length, host_memory_bytes: os.totalmem(),
    rss_sum_bytes: rss, observed_processes: observed.size, sampled_processes: sampled, complete_for_observed_tree: sampled === observed.size, scope: 'observable-owned-descendants-of-confirmed-product-roots',
    metric: 'sum-of-process-rss-shared-pages-may-repeat' }
}
