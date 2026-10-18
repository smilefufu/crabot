import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runBounded } from './run-bounded.mjs'
import { selectPackageSource, withPackageSource, uvTransport, selectPythonDownloadSource } from './install-network.mjs'

const exec = promisify(execFile)

export function findUv() {
  const local = join(process.env.USERPROFILE || process.env.HOME || '', '.local/bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
  return existsSync(local) ? local : 'uv'
}

export async function prepareMemoryDependencies(directory, { dev = false, logger = console, source, uv = findUv(), relocatable = false } = {}) {
  const deadline = Date.now() + 20 * 60_000
  const transport = await uvTransport(uv, directory)
  const originalLock = await readFile(join(directory, 'uv.lock'))
  const temporary = await mkdtemp(join(tmpdir(), 'crabot-memory-deps-'))
  const requirements = join(temporary, 'requirements.txt')
  const python = join(directory, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  try {
    if (transport.UV_OFFLINE === '1') {
      logger.info('Offline Memory: retaining the original frozen preparation path')
      const options = { cwd: directory, env: { ...process.env, UV_OFFLINE: '1' }, captureError: true }
      if (relocatable) await runBounded(uv, ['venv', '--relocatable', '--no-python-downloads', '--allow-existing', '.venv'], options)
      await runBounded(uv, ['sync', '--frozen', ...(dev ? [] : ['--no-dev']), ...(relocatable ? ['--no-editable'] : []), '--offline'], { ...options, timeout: Math.max(1, deadline - Date.now()) })
      await runBounded(uv, ['run', '--frozen', ...(dev ? [] : ['--no-dev']), ...(relocatable ? ['--no-editable'] : []), '--offline', 'python', '-c', 'import src.main'], { ...options, timeout: Math.max(1, deadline - Date.now()) })
      if (relocatable) await recordPreparedEnvironment(directory)
      return
    }
    source ??= await selectPackageSource('python', { logger, env: { ...process.env, ...transport } })
    await withPackageSource(source, async (index, env, remaining) => {
      env = { ...env, ...transport }; delete env.UV_CONFIG_FILE
      const deadline = Date.now() + remaining
      const run = (args) => runBounded(uv, args, { cwd: directory, env, timeout: Math.max(1, deadline - Date.now()), captureError: true })
      logger.info('Memory: exporting the frozen lock with hashes')
      await run(['export', '--frozen', ...(dev ? [] : ['--no-dev']), '--no-emit-project', '--output-file', requirements])
      const content = await readFile(requirements, 'utf8')
      // Current product runtime dependencies must remain pinned registry packages.
      if (/(^|\n)\s*(?:-e\s|[^#\n]+\s@\s)/.test(content)) throw Object.assign(new Error('Memory lock contains non-registry dependencies'), { code: 'CRABOT_SOURCE_AWARE_LOCK' })
      logger.info('Memory: preparing its private environment')
      let request = process.env.UV_PYTHON
      if (!request) {
        try {
          const { stdout } = await exec(uv, ['python', 'pin'], { cwd: directory, env, timeout: Math.max(1, Math.min(5000, deadline - Date.now())), maxBuffer: 65536 })
          request = stdout.trim()
        } catch (error) { if (!/No Python version file found/.test(error.stderr ?? '')) throw error }
      }
      try { await run(['venv', ...(relocatable ? ['--relocatable'] : []), '--no-python-downloads', ...(request ? ['--python', request] : []), '--allow-existing', '.venv']) }
      catch (error) {
        if (env.UV_PYTHON_DOWNLOADS !== 'automatic' || !/No (?:interpreter|Python).*found|No Python installation/i.test(error.stderr ?? '')) throw error
        request ||= '3.12.12'
        logger.info('Memory: acquiring the selected standalone Python interpreter')
        const download = await selectPythonDownloadSource(uv, request, { cwd: directory, env, logger })
        await withPackageSource(download, (url, child, budget) => runBounded(uv, ['venv', ...(relocatable ? ['--relocatable'] : []), '--python', request, '--allow-existing', '.venv'], { cwd: directory, env: child, timeout: budget, captureError: true }), { env, logger, timeout: Math.max(1, deadline - Date.now()) })
      }
      logger.info(`Memory: installing locked packages from ${index}`)
      const indexes = ['--index', index, '--default-index', index]
      await run(['pip', 'sync', '--python', python, '--require-hashes', ...indexes, requirements])
      await run(['pip', 'install', '--python', python, '--no-deps', ...(relocatable ? [] : ['--editable']), '.', ...indexes])
      // A frozen offline audit checks that uv recognizes this environment without fetching packages.
      await run(['run', '--frozen', ...(dev ? [] : ['--no-dev']), ...(relocatable ? ['--no-editable'] : []), '--offline', 'python', '-c', 'import src.main'])
    }, { logger, timeout: Math.max(1, deadline - Date.now()) })
    if (relocatable) await recordPreparedEnvironment(directory)
  } catch (error) {
    if (error.code !== 'CRABOT_SOURCE_AWARE_LOCK') throw error
    if (relocatable) throw new Error('Relocatable Memory preparation requires pinned registry dependencies')
    logger.warn('Source-aware Memory lock: retaining the original frozen preparation path')
    await runBounded(uv, ['sync', '--frozen', ...(dev ? [] : ['--no-dev']), ...(relocatable ? ['--no-editable'] : [])], { cwd: directory, captureError: true, timeout: Math.max(1, deadline - Date.now()) })
    if (relocatable) await recordPreparedEnvironment(directory)
  } finally {
    await rm(temporary, { recursive: true, force: true })
    if (!(await readFile(join(directory, 'uv.lock'))).equals(originalLock)) throw new Error('Memory preparation changed the frozen lockfile')
  }
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function recordPreparedEnvironment(directory) {
  await writeFile(join(directory, 'prepared-environment.json'), JSON.stringify({
    schema_version: 1, platform: process.platform, arch: process.arch,
    lock_sha256: digest(await readFile(join(directory, 'uv.lock'))),
    project_sha256: digest(await readFile(join(directory, 'pyproject.toml'))),
  }))
}

/** Prepared environments contain a non-editable project and uv relocatable launchers. */
export async function preparedMemoryPython(directory) {
  const marker = join(directory, 'prepared-environment.json')
  if (!existsSync(marker)) return null
  const value = JSON.parse(await readFile(marker, 'utf8'))
  if (value.schema_version !== 1 || value.platform !== process.platform || value.arch !== process.arch
    || value.lock_sha256 !== digest(await readFile(join(directory, 'uv.lock')))
    || value.project_sha256 !== digest(await readFile(join(directory, 'pyproject.toml')))) throw new Error('Prepared Memory environment is stale; prepare target dependencies before restart')
  const python = join(directory, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  if (!existsSync(python)) throw new Error('Prepared Memory interpreter is missing')
  return python
}
