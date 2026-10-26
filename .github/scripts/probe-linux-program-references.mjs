// Bounded read-only CI diagnosis; raw unknown receipts are never filtered.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import identity from '../../scripts/lib/process-identity.cjs'
import { captureLinuxRemovalSystemProcesses } from '../../scripts/lib/desktop-removal-system-processes.mjs'

assert.equal(process.env.GITHUB_ACTIONS === 'true' || process.getuid?.() === 0 && process.argv[2] === '--identity', true)
assert.equal(process.platform, 'linux')
async function describe(pid) {
  assert.match(String(pid), /^[1-9][0-9]*$/)
  const prefix = '/proc/' + pid, stat = await fs.readFile(prefix + '/stat', 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  const parent = Number(fields[1]), started = fields[19], fork_without_exec = (BigInt(fields[6]) & 64n) !== 0n
  const readImage = async id => {
    try {
      const image = await fs.readlink('/proc/' + id + '/exe'), value = await fs.stat(image)
      return { image, uid: value.uid, mode: value.mode & 0o777 }
    } catch (error) { return { error: error.code } }
  }
  const value = { pid, parent, started, fork_without_exec, comm: (await fs.readFile(prefix + '/comm', 'utf8')).trim().slice(0, 64),
    executable: await readImage(pid), parent_executable: await readImage(parent) }
  const after = await fs.readFile(prefix + '/stat', 'utf8')
  const current = after.slice(after.lastIndexOf(')') + 2).trim().split(/\s+/)
  assert.equal(current[1], fields[1]); assert.equal(current[19], started)
  return value
}
if (process.argv[2] === '--identity') {
  assert.equal(process.getuid(), 0)
  assert.ok(process.argv.length >= 4 && process.argv.length <= 11)
  const results = await Promise.all(process.argv.slice(3).map(pid => describe(Number(pid)).catch(error => ({ pid: Number(pid), unavailable: error.code || error.name }))))
  console.log(JSON.stringify(results))
} else {
  assert.equal(process.argv.length, 2); assert.ok(process.getuid() > 0)
  const directory = await fs.mkdtemp(path.join(homedir(), 'crabot-empty-reference-'))
  try {
    const classify = captureLinuxRemovalSystemProcesses(directory)
    const receipt = await identity.inspectProgramReferences({ roots: [directory], files: [] })
    const unknown = receipt.unknown_details.slice(0, 8), pids = [...new Set(unknown.map(item => item.pid))]
    const ordinary = await Promise.all(pids.map(pid => describe(pid).catch(error => ({ pid, unavailable: error.code || error.name }))))
    let privileged = []
    if (pids.length) {
      const result = await promisify(execFile)('/usr/bin/sudo', [process.execPath, fileURLToPath(import.meta.url), '--identity', ...pids.map(String)],
        { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 })
      privileged = JSON.parse(result.stdout)
    }
    let manager
    try {
      const { stdout } = await promisify(execFile)('/usr/bin/systemctl', ['--system', 'show', 'user@' + process.getuid() + '.service',
        '--property=MainPID,ExecStart,ExecMainStartTimestampMonotonic,ControlGroup'], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 })
      const properties = Object.fromEntries(stdout.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
      manager = { pid: properties.MainPID, start_monotonic: properties.ExecMainStartTimestampMonotonic,
        control_group: properties.ControlGroup, image: /\bpath=([^;]+?)\s*;/.exec(properties.ExecStart)?.[1] }
    } catch (error) { manager = { unavailable: error.code || error.name } }
    const classified = receipt.complete || classify(receipt)
    assert.equal(classified, true, 'Default system roles must not block an empty owned directory')
    assert.equal(classify({ ...receipt, processes: [{ pid: process.pid }] }), false, 'An explicit program reference must still block')
    console.log('CRABOT_EMPTY_PROGRAM_REFERENCES ' + JSON.stringify({ classified, manager, complete: receipt.complete, incomplete: receipt.incomplete,
      references: receipt.processes.length, unknown_count: receipt.unknown_pids.length, unknown, ordinary, privileged }))
  } finally { await fs.rmdir(directory) }
}
