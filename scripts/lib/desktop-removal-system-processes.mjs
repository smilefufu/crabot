// A local classification of raw macOS unknowns, never an altered native receipt.
import path from 'node:path'
import physical from './physical-fs.cjs'
import identity from './process-identity.cjs'
const systemRoots = ['/System/Library', '/System/Applications', '/usr/bin', '/usr/sbin', '/usr/libexec', '/bin', '/sbin']
const inside = (file, root) => file === root || file.startsWith(root + '/')
export function captureMacRemovalSystemProcesses(installRoot, api = identity, filesystem = physical) {
  const candidates = new Map()
  try {
    const self = api.inspectProcess(process.pid), pids = api.listProcessIds(), processes = new Map()
    if (!self || !Array.isArray(pids) || pids.length > 32768) return () => false
    for (const pid of pids) {
      try { const item = api.inspectProcess(pid); if (item?.pid === pid) processes.set(pid, { ...item }) }
      catch { /* An unobserved identity can never qualify. */ }
    }
    const systemFile = file => {
      if (typeof file !== 'string' || path.posix.normalize(file) !== file || inside(file, installRoot)
        || !systemRoots.some(root => inside(file, root)) || filesystem.realpathSync(file) !== file) return false
      const stat = filesystem.lstatSync(file)
      return stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0
    }
    for (const item of processes.values()) {
      if (item.owner !== self.owner) continue
      const chain = [], seen = new Set()
      let current = item
      try {
        while (current && chain.length < 128 && !seen.has(current.pid) && systemFile(current.executable)) {
          chain.push(current); seen.add(current.pid)
          if (current.parent === 1) { candidates.set(item.pid, chain); break }
          current = processes.get(current.parent)
        }
      } catch { /* Canonical system image or ancestry is not independently known. */ }
    }
    return observation => {
      try {
        if (observation.incomplete !== false || observation.complete !== false || !Array.isArray(observation.processes) || observation.processes.length !== 0
          || !Array.isArray(observation.unknown_pids) || !observation.unknown_pids.length
          || !Array.isArray(observation.unknown_details) || observation.unknown_details.length !== observation.unknown_pids.length
          || new Set(observation.unknown_pids).size !== observation.unknown_pids.length) return false
        return observation.unknown_pids.every(pid => {
          const details = observation.unknown_details.filter(item => item.pid === pid), chain = candidates.get(pid)
          if (!chain || details.length !== 1 || !['descriptor_list', 'descriptor_details', 'fileport_list', 'fileport_details'].includes(details[0].stage)
            || ![1, 13].includes(details[0].os_error)) return false
          return chain.every(before => {
            const after = api.inspectProcess(before.pid)
            return api.sameProcess(before, after) && before.parent === after.parent && systemFile(after.executable)
          })
        })
      } catch { return false }
    }
  } catch { return () => false }
}
