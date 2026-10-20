// A fixed OS copier gate, not a general shell/command runner. Only the isolated copy host uses it.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import native from './process-identity.cjs'

const failure = () => Object.assign(new Error('工作区复制进程未能核验，尚未放行文件操作。'), { code: 'WORKSPACE_COPY_ACTOR_UNVERIFIED' })
const gate = `printf 'crabot-workspace-ready-v1\\n' >&3
IFS= read -r permit <&3 || exit 125
[ "$permit" = crabot-workspace-copy-v1 ] || exit 125
exec 3<&-
exec /usr/bin/tar "$@"`
export async function spawnWorkspaceTar(mode) {
  if (!['darwin', 'linux'].includes(process.platform) || mode !== 'pack' && mode !== 'unpack') throw failure()
  const metadata = process.platform === 'darwin' ? ['--acls', '--xattrs', '--fflags', '--mac-metadata'] : ['--acls', '--xattrs', '--xattrs-include=*']
  const args = mode === 'pack' ? ['-c', '--format=pax', ...metadata, '-f', '-', '.'] : ['-x', ...metadata, '--same-owner', '--same-permissions', '-f', '-']
  const allowed = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP'])
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key)))
  const child = spawn('/bin/sh', ['-c', gate, 'crabot-workspace-tar', ...args], { env, stdio: ['pipe', 'pipe', 'inherit', 'pipe'] })
  const control = child.stdio[3]; control.on('error', () => {})
  const closed = new Promise(resolve => { child.once('error', () => resolve(null)); child.once('close', code => resolve(code)) })
  const ready = new Promise((resolve, reject) => {
    let frame = ''
    const clear = () => { clearTimeout(timer); control.off('data', receive); control.off('close', rejectReady); control.off('error', rejectReady) }
    const rejectReady = () => { clear(); reject(failure()) }
    const receive = bytes => {
      frame += bytes.toString('ascii')
      if (frame.length > 64 || !'crabot-workspace-ready-v1\n'.startsWith(frame)) rejectReady()
      else if (frame === 'crabot-workspace-ready-v1\n') { clear(); resolve() }
    }
    const timer = setTimeout(rejectReady, 5000)
    control.on('data', receive); control.once('close', rejectReady); control.once('error', rejectReady)
  })
  let permitted = false
  try {
    await Promise.all([once(child, 'spawn'), ready])
    const identity = native.inspectProcess(child.pid), self = native.inspectProcess(process.pid)
    if (!identity || identity.parent !== self.pid || identity.owner !== self.owner) throw failure()
    return Object.freeze({ child, identity: Object.freeze(identity), closed,
      async permit() {
        if (permitted || child.exitCode !== null || child.signalCode !== null || !native.sameProcess(identity, native.inspectProcess(child.pid))) throw failure()
        permitted = true
        await new Promise((resolve, reject) => control.end('crabot-workspace-copy-v1\n', error => error ? reject(failure()) : resolve()))
      },
      cancel() { control.destroy() },
    })
  } catch { control.destroy(); throw failure() }
}
