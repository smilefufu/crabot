import { spawn } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import runtime from './scrapling-runtime.cjs'

// detached 创建专属进程组；只能终止本次准备命令拥有的进程。
export function runBounded(command, args, { cwd, env = process.env, timeout = 20 * 60_000, signal } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', detached: process.platform !== 'win32' })
    let reason
    let forceTimer
    const killOwned = (force) => {
      if (!child.pid) return
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])], { stdio: 'ignore' })
      else { try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM') } catch {} }
    }
    function terminate(message) {
      reason ??= new Error(message)
      killOwned(false)
      forceTimer ??= setTimeout(() => killOwned(true), 2000)
    }
    const timer = setTimeout(() => terminate(`${command}: preparation timed out`), timeout)
    const abort = () => terminate(`${command}: preparation cancelled`)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.on('error', err => { reason = err })
    child.on('close', code => {
      if (reason || code !== 0) killOwned(true)
      clearTimeout(timer); clearTimeout(forceTimer)
      signal?.removeEventListener('abort', abort)
      if (reason || code !== 0) fail(reason ?? new Error(`${command} exited with code ${code}`))
      else done()
    })
  })
}
function findUv() {
  const local = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
  return existsSync(local) ? local : 'uv'
}
async function build(root, directory, signal) {
  const input = join(root, 'scripts', 'scrapling')
  const versions = JSON.parse(await fs.readFile(join(input, 'runtime.json'), 'utf8'))
  const download = join(directory, '.python-download')
  const env = { ...process.env, UV_PYTHON_INSTALL_DIR: download, UV_CACHE_DIR: join(directory, '.uv-cache'), UV_LINK_MODE: 'copy', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }
  const run = (command, args, extra = {}) => runBounded(command, args, { cwd: root, env, signal, ...extra })
  await run(findUv(), ['python', 'install', versions.python, '--install-dir', download, '--no-bin', '--no-registry'])
  const candidates = (await fs.readdir(download, { withFileTypes: true })).filter(p => p.isDirectory() && p.name.startsWith('cpython-')).map(p => p.name)
  if (candidates.length !== 1) throw new Error('standalone Python installation incomplete')
  await fs.rename(join(download, candidates[0]), join(directory, 'python'))
  const python = join(directory, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3.12')
  await run(findUv(), ['pip', 'sync', '--python', python, '--target', join(directory, 'packages'), '--only-binary', ':all:', '--require-hashes', join(input, 'requirements.lock')])
  env.PYTHONPATH = join(directory, 'packages')
  env.PLAYWRIGHT_BROWSERS_PATH = join(directory, 'browsers')
  env.PLAYWRIGHT_SKIP_BROWSER_GC = '1'
  env.PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT = '120000'
  await run(python, ['-m', 'playwright', 'install', '--no-shell', 'chromium'])
  await run(python, ['-m', 'patchright', 'install', '--no-shell', 'chromium'])
  await fs.copyFile(join(input, 'server.py'), join(directory, 'server.py'))
  await run(python, [join(input, 'build.py'), directory, input])
  await fs.rm(download, { recursive: true, force: true })
  await fs.rm(env.UV_CACHE_DIR, { recursive: true, force: true })
}
export async function prepareRuntime(root, { release = 'source', signal, builder = build, lockTimeout = 10 * 60_000 } = {}) {
  root = resolve(root)
  try { return runtime.loadRuntime(root, { full: true }) } catch {}
  const lock = join(root, '.scrapling-prepare.lock')
  const started = Date.now()
  for (;;) {
    signal?.throwIfAborted()
    try {
      await fs.mkdir(lock)
      try { await fs.writeFile(join(lock, 'pid'), String(process.pid)) } catch (err) {
        await fs.rm(lock, { recursive: true, force: true })
        throw err
      }
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      // PID 不存活时恢复被中断的准备；不给运行中的准备抢锁。
      const pid = Number(await fs.readFile(join(lock, 'pid'), 'utf8').catch(() => ''))
      if (!pid && Date.now() - (await fs.stat(lock)).mtimeMs > 5000) {
        await fs.rm(lock, { recursive: true, force: true }); continue
      }
      if (pid > 0) {
        try { process.kill(pid, 0) } catch (e) {
          if (e.code === 'ESRCH') { await fs.rm(lock, { recursive: true, force: true }); continue }
        }
      }
      if (Date.now() - started >= lockTimeout) throw new Error('Scrapling preparation lock timed out; retry after the current installation finishes')
      await delay(250, undefined, { signal })
    }
  }
  let pending
  try {
    try { return runtime.loadRuntime(root, { full: true }) } catch {}
    const fingerprint = runtime.fingerprint(root)
    const name = `.scrapling-runtime-${release.replace(/[^a-zA-Z0-9.-]/g, '-')}-${fingerprint}-${randomUUID().slice(0, 8)}`
    pending = join(root, name + '.building')
    await fs.mkdir(pending)
    await builder(root, pending, signal)
    const manifest = JSON.parse(await fs.readFile(join(pending, 'inventory.json'), 'utf8'))
    await fs.writeFile(join(pending, 'ready.json'), JSON.stringify({ ...manifest, fingerprint, platform: process.platform, arch: process.arch }, null, 2) + '\n')
    await fs.chmod(join(pending, 'ready.json'), 0o644)
    runtime.validateDirectory(root, pending, { full: true })
    await fs.rename(pending, join(root, name))
    pending = undefined
    const pointer = join(root, `scrapling-runtime.json.${process.pid}.tmp`)
    await fs.writeFile(pointer, JSON.stringify({ directory: name }) + '\n')
    await fs.chmod(pointer, 0o644)
    await fs.rename(pointer, join(root, 'scrapling-runtime.json'))
    return runtime.loadRuntime(root, { full: true })
  } finally {
    if (pending) await fs.rm(pending, { recursive: true, force: true })
    await fs.rm(lock, { recursive: true, force: true })
  }
}
