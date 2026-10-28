// One fixed filesystem probe in a directory object selected by its verified parent.
import fs from 'node:fs'
import native from './lib/process-identity.cjs'
import { processBirthAtLeast } from './lib/owned-process-tree.cjs'

const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const fail = () => { throw new Error('WORKSPACE_ROOT_PROBE_FAILED') }
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino
let finished = false
function finish(code, frame) {
  if (finished) return
  finished = true; clearTimeout(timer); process.exitCode = code
  const close = () => { if (process.connected) process.disconnect() }
  if (frame && process.connected) process.send(frame, error => { if (error) process.exitCode = 1; close() })
  else close()
}
const timer = setTimeout(() => finish(1), 5000)
process.once('disconnect', () => { if (!finished) finish(1) })
process.once('message', frame => {
  let directoryOwned = false, fileFd, created, marker
  try {
    if (!fields(frame, ['kind', 'nonce', 'root', 'parent']) || frame.kind !== 'workspace_root_probe'
      || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(frame.nonce)
      || !fields(frame.root, ['path', 'dev', 'ino', 'native_id']) || !fields(frame.parent, ['pid', 'parent', 'owner', 'started', 'executable'])) fail()
    const self = native.inspectProcess(process.pid)
    if (!self || self.parent !== frame.parent.pid || self.owner !== frame.parent.owner
      || !native.sameProcess(frame.parent, native.inspectProcess(frame.parent.pid))
      || !processBirthAtLeast(self.started, frame.parent.started)) fail()
    if (process.platform !== 'win32') {
      const stat = fs.fstatSync(3, { bigint: true })
      if (!stat.isDirectory() || String(stat.dev) !== frame.root.dev || String(stat.ino) !== frame.root.ino || stat.uid !== BigInt(process.getuid())) fail()
      directoryOwned = true
      native.enterDirectoryFd(3, frame.root.dev, frame.root.ino)
    }
    const checkRoot = () => {
      const stat = fs.statSync('.', { bigint: true })
      if (!stat.isDirectory() || String(stat.dev) !== frame.root.dev || String(stat.ino) !== frame.root.ino
        || (process.platform === 'win32' ? native.inspectDirectoryFileId(process.cwd()) !== frame.root.native_id || !native.isOwnedDirectory(process.cwd())
          : stat.uid !== BigInt(process.getuid()))) fail()
    }
    checkRoot()
    marker = '.crabot-workspace-probe-' + frame.nonce
    const content = Buffer.from('Crabot workspace probe ' + frame.nonce + '\n')
    try {
      fileFd = fs.openSync(marker, 'wx+', 0o600)
      created = fs.fstatSync(fileFd, { bigint: true })
      if (!created.isFile() || created.nlink !== 1n) fail()
      checkRoot()
      fs.writeFileSync(fileFd, content); fs.fsyncSync(fileFd)
      const read = Buffer.alloc(content.length)
      let offset = 0
      while (offset < read.length) {
        const count = fs.readSync(fileFd, read, offset, read.length - offset, offset)
        if (!count) fail()
        offset += count
      }
      const current = fs.fstatSync(fileFd, { bigint: true })
      if (!sameFile(current, created) || current.nlink !== 1n || current.size !== BigInt(content.length) || !read.equals(content)) fail()
      checkRoot()
    } finally {
      if (created) {
        const entry = fs.lstatSync(marker, { bigint: true })
        if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n || !sameFile(entry, created)) fail()
        fs.unlinkSync(marker)
      }
      if (fileFd !== undefined) { const fd = fileFd; fileFd = undefined; fs.closeSync(fd) }
      if (directoryOwned) { fs.fsyncSync(3); directoryOwned = false; fs.closeSync(3) }
    }
    checkRoot()
    finish(0, { kind: 'workspace_root_probe_complete', nonce: frame.nonce, root: frame.root })
  } catch {
    if (fileFd !== undefined) { try { fs.closeSync(fileFd) } catch {} }
    if (directoryOwned) { try { fs.closeSync(3) } catch {} }
    finish(1)
  }
})
