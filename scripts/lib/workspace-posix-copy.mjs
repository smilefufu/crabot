// Neutral physical copy only, in an isolated Host. Fixed-job and staging authorization belong to its caller.
import fs from 'node:fs'
import { finished } from 'node:stream/promises'
import native from './process-identity.cjs'
import { syncWorkspaceDirectoryFd } from './workspace-sync.mjs'
import { spawnWorkspaceTar } from './workspace-tar.mjs'

const failure = () => Object.assign(new Error('固定工作区复制未能完成，原目录与暂存保留。'), { code: 'WORKSPACE_COPY_UNVERIFIED' })
export async function copyWorkspaceTreeFd(sourceFd, treeFd, containerFd, { journal, signal } = {}) {
  if (!['darwin', 'linux'].includes(process.platform)) throw failure()
  if (signal?.aborted) throw failure()
  const source = fs.fstatSync(sourceFd, { bigint: true }), tree = fs.fstatSync(treeFd, { bigint: true }), container = fs.fstatSync(containerFd, { bigint: true })
  if (![source, tree, container].every(stat => stat.isDirectory()) || tree.dev !== container.dev
    || source.dev === tree.dev && source.ino === tree.ino || source.dev === container.dev && source.ino === container.ino || tree.ino === container.ino) throw failure()
  const actors = [], completions = [], exits = {}; let failed = false, force, registered = false, completionAttempted = false
  let stage = 'bind-directories', transportCode
  function stop() {
    failed = true
    for (const child of actors) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    force ??= setTimeout(() => {
      for (const child of actors) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 2000)
  }
  async function actor(mode) {
    const gated = await spawnWorkspaceTar(mode), child = gated.child
    actors.push(child)
    if (failed) stop()
    const closed = gated.closed.then(code => { exits[mode] = code; if (code !== 0) stop(); return code === 0 })
    completions.push(closed)
    return { ...gated, closed }
  }
  signal?.addEventListener('abort', stop)
  try {
    if (signal?.aborted) throw failure()
    native.enterDirectoryFd(sourceFd, source.dev.toString(), source.ino.toString())
    stage = 'pack-start'
    const pack = await actor('pack'); pack.child.stdin.end()
    if (failed) throw failure()
    native.enterDirectoryFd(treeFd, tree.dev.toString(), tree.ino.toString())
    stage = 'unpack-start'
    const unpack = await actor('unpack')
    unpack.child.stdout.resume()
    pack.child.stdout.on('error', stop); pack.child.stdout.pipe(unpack.child.stdin)
    const transport = finished(unpack.child.stdin).catch(error => {
      transportCode = ['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR'].includes(error?.code) ? error.code : 'unverified'
      stop()
    })
    if (failed) throw failure()
    stage = 'actors-register'
    if (journal) {
      const tools = [{ role: 'pack', process: pack.identity }, { role: 'unpack', process: unpack.identity }]
      if ((await journal.register(tools)).dispatch !== 'dispatch') throw failure()
      registered = true
      if (failed || signal?.aborted) throw failure()
      if ((await journal.permit()).dispatch !== 'dispatch') throw failure()
    }
    if (failed || signal?.aborted) throw failure()
    stage = 'actors-permit'
    await pack.permit(); await unpack.permit()
    stage = 'actors-finish'
    const results = await Promise.all([pack.closed, unpack.closed, transport])
    if (failed || results[0] !== true || results[1] !== true) throw failure()
    stage = 'actors-complete'
    if (journal) { completionAttempted = true; await journal.complete() }
    stage = 'directory-times'
    native.copyDirectoryTimesFd(sourceFd, treeFd)
    stage = 'directory-sync'
    syncWorkspaceDirectoryFd(treeFd, { dev: tree.dev.toString(), ino: tree.ino.toString() })
    stage = 'container-sync'
    fs.fsyncSync(containerFd)
  } catch (error) {
    stop(); await Promise.all(completions)
    if (registered && !completionAttempted) try { await journal.complete() } catch { /* Unknown confirmation retains the original failure and maintenance. */ }
    if (error && typeof error === 'object') Object.assign(error, { copy_stage: stage, pack_exit: exits.pack ?? null, unpack_exit: exits.unpack ?? null, transport_code: transportCode ?? null })
    throw error
  } finally { signal?.removeEventListener('abort', stop); clearTimeout(force) }
}
