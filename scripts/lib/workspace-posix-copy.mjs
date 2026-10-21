// Neutral physical copy only, in an isolated Host. Fixed-job and staging authorization belong to its caller.
import fs from 'node:fs'
import { finished } from 'node:stream/promises'
import native from './process-identity.cjs'
import { syncWorkspaceDirectoryFd } from './workspace-sync.mjs'
import { spawnWorkspaceTar } from './workspace-tar.mjs'

const failure = () => Object.assign(new Error('固定工作区复制未能完成，原目录与暂存保留。'), { code: 'WORKSPACE_COPY_UNVERIFIED' })
export async function copyWorkspaceTreeFd(sourceFd, treeFd, containerFd, { journal } = {}) {
  if (!['darwin', 'linux'].includes(process.platform)) throw failure()
  const source = fs.fstatSync(sourceFd, { bigint: true }), tree = fs.fstatSync(treeFd, { bigint: true }), container = fs.fstatSync(containerFd, { bigint: true })
  if (![source, tree, container].every(stat => stat.isDirectory()) || tree.dev !== container.dev
    || source.dev === tree.dev && source.ino === tree.ino || source.dev === container.dev && source.ino === container.ino || tree.ino === container.ino) throw failure()
  const actors = [], completions = []; let failed = false, force, registered = false, completionAttempted = false
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
    const closed = gated.closed.then(code => { if (code !== 0) stop(); return code === 0 })
    completions.push(closed)
    return { ...gated, closed }
  }
  try {
    native.enterDirectoryFd(sourceFd, source.dev.toString(), source.ino.toString())
    const pack = await actor('pack'); pack.child.stdin.end()
    native.enterDirectoryFd(treeFd, tree.dev.toString(), tree.ino.toString())
    const unpack = await actor('unpack')
    unpack.child.stdout.resume()
    pack.child.stdout.on('error', stop); pack.child.stdout.pipe(unpack.child.stdin)
    const transport = finished(unpack.child.stdin).catch(() => { stop() })
    if (failed) throw failure()
    if (journal) {
      const tools = [{ role: 'pack', process: pack.identity }, { role: 'unpack', process: unpack.identity }]
      if ((await journal.register(tools)).dispatch !== 'dispatch') throw failure()
      registered = true
      if ((await journal.permit()).dispatch !== 'dispatch') throw failure()
    }
    await pack.permit(); await unpack.permit()
    const results = await Promise.all([pack.closed, unpack.closed, transport])
    if (failed || results[0] !== true || results[1] !== true) throw failure()
    if (journal) { completionAttempted = true; await journal.complete() }
    native.copyDirectoryTimesFd(sourceFd, treeFd)
    syncWorkspaceDirectoryFd(treeFd, { dev: tree.dev.toString(), ino: tree.ino.toString() })
    fs.fsyncSync(containerFd)
  } catch (error) {
    stop(); await Promise.all(completions)
    if (registered && !completionAttempted) try { await journal.complete() } catch { /* Unknown confirmation retains the original failure and maintenance. */ }
    throw error
  } finally { clearTimeout(force) }
}
