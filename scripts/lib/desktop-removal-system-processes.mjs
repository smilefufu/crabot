// Local classification of raw OS-protected unknowns, never an altered native receipt.
import path from 'node:path'
import { execFileSync } from 'node:child_process'
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

// Linux exposes these two system roles through the root service manager even
// when /proc/PID/exe is protected. This is role evidence, not a full FD receipt.
export function captureLinuxRemovalSystemProcesses(installRoot, filesystem = physical, run = execFileSync, uid = process.getuid?.()) {
  try {
    if (!Number.isSafeInteger(uid) || uid < 1) return () => false
    const unit = 'user@' + uid + '.service', group = '/user.slice/user-' + uid + '.slice/' + unit
    const secureImage = file => {
      if (!['/usr/bin/systemctl', '/usr/bin/getconf', '/usr/lib/systemd/systemd', '/usr/lib/systemd/systemd-executor'].includes(file)
        || inside(file, installRoot) || filesystem.realpathSync(file) !== file) return false
      const stat = filesystem.lstatSync(file)
      return stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0
    }
    if (!secureImage('/usr/bin/systemctl') || !secureImage('/usr/bin/getconf')) return () => false
    const options = { encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', SYSTEMD_COLORS: '0' } }
    const ticks = BigInt(run('/usr/bin/getconf', ['CLK_TCK'], options).trim())
    if (ticks < 1n || ticks > 1000000n) return () => false
    const readService = () => {
      if (!secureImage('/usr/bin/systemctl')) throw new Error('unverified system manager client')
      const output = run('/usr/bin/systemctl', ['--system', '--no-pager', '--no-ask-password', 'show', unit,
        '--property=MainPID,ExecStart,ExecMainStartTimestampMonotonic,ControlGroup'], options)
      const properties = Object.fromEntries(output.trim().split('\n').map(line => {
        const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]
      }))
      const image = /\bpath=([^;]+?)\s*;/.exec(properties.ExecStart)?.[1]
      if (image !== '/usr/lib/systemd/systemd' || !secureImage(image) || properties.ControlGroup !== group
        || !/^[1-9][0-9]*$/.test(properties.MainPID) || !/^[1-9][0-9]*$/.test(properties.ExecMainStartTimestampMonotonic)) throw new Error('unverified user manager')
      return { pid: Number(properties.MainPID), started: BigInt(properties.ExecMainStartTimestampMonotonic) * ticks / 1000000n,
        stamp: properties.ExecMainStartTimestampMonotonic, image }
    }
    const readProcess = pid => {
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('invalid process')
      const prefix = '/proc/' + pid, stat = filesystem.lstatSync(prefix)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) throw new Error('wrong process owner')
      const text = filesystem.readFileSync(prefix + '/stat', 'utf8'), end = text.lastIndexOf(')'), fields = text.slice(end + 2).trim().split(/\s+/)
      if (!text.startsWith(pid + ' (') || end < 0 || !/^[0-9]+$/.test(fields[19])) throw new Error('invalid kernel identity')
      const cgroups = filesystem.readFileSync(prefix + '/cgroup', 'utf8').trim().split('\n')
      if (!cgroups.some(line => { const value = line.slice(line.lastIndexOf(':') + 1); return value === group || value.startsWith(group + '/') })) throw new Error('wrong system unit')
      return { pid, parent: Number(fields[1]), name: text.slice(text.indexOf('(') + 1, end), started: fields[19], flags: fields[6] }
    }
    const service = readService(), manager = readProcess(service.pid), candidates = new Map()
    if (manager.parent !== 1 || BigInt(manager.started) !== service.started || manager.name !== 'systemd') return () => false
    candidates.set(manager.pid, manager)
    const children = filesystem.readFileSync('/proc/' + manager.pid + '/task/' + manager.pid + '/children', 'utf8').trim().split(/\s+/).filter(Boolean)
    if (children.length > 32768) return () => false
    for (const child of children) {
      try {
        const item = readProcess(Number(child))
        if (item.parent === manager.pid && item.name === '(sd-pam)' && (BigInt(item.flags) & 64n) !== 0n
          && BigInt(item.started) >= BigInt(manager.started) && secureImage('/usr/lib/systemd/systemd-executor')) candidates.set(item.pid, item)
      } catch { /* An unverified child never qualifies. */ }
    }
    const same = (before, after) => Object.keys(before).every(key => before[key] === after[key])
    return observation => {
      try {
        if (observation.incomplete !== false || observation.complete !== false || !Array.isArray(observation.processes) || observation.processes.length
          || !Array.isArray(observation.unknown_pids) || !observation.unknown_pids.length
          || !Array.isArray(observation.unknown_details) || observation.unknown_details.length !== observation.unknown_pids.length
          || new Set(observation.unknown_pids).size !== observation.unknown_pids.length) return false
        const current = readService()
        if (!same(service, current) || !same(manager, readProcess(manager.pid))) return false
        return observation.unknown_pids.every(pid => {
          const before = candidates.get(pid), details = observation.unknown_details.filter(item => item.pid === pid)
          return before && details.length === 1 && ['identity', 'descriptor_list', 'descriptor_details'].includes(details[0].stage)
            && [1, 13].includes(details[0].os_error) && same(before, readProcess(pid))
            && (pid === manager.pid || secureImage('/usr/lib/systemd/systemd-executor'))
        })
      } catch { return false }
    }
  } catch { return () => false }
}
