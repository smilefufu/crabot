import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'

function commandLine(pid: number): Promise<string> {
  return new Promise((done, fail) => execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 2_000 }, (error, output) => {
    if (error && error.code !== 1) fail(error); else done(output.trim())
  }))
}

/** Runtime ownership only; contains no permissions, action history or credentials. */
export async function acquireRuntimeGuard(directory: string): Promise<{ record: (pid: number, socket: string) => Promise<void>; release: () => Promise<void> }> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const lock = join(directory, 'runtime.lock')
  try { await fs.mkdir(lock, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const previous = JSON.parse(await fs.readFile(join(lock, 'owner.json'), 'utf8'))
    try { process.kill(previous.owner_pid, 0); throw new Error('COMPUTER_USE_PREVIOUS_RUNTIME_BUSY') }
    catch (checkError) { if ((checkError as NodeJS.ErrnoException).code !== 'ESRCH') throw checkError }
    if (process.platform === 'darwin' && !previous.native_pid && previous.socket) {
      previous.native_pid = Number(await fs.readFile(join(dirname(previous.socket), 'driver.pid'), 'utf8').catch(() => '0'))
    }
    if (previous.native_pid) {
      if (process.platform === 'darwin') await terminateOwnedMacRuntime(previous.native_pid, previous.socket)
      else {
        try { process.kill(previous.native_pid, 0); throw new Error('COMPUTER_USE_PREVIOUS_NATIVE_RUNTIME_UNKNOWN') }
        catch (checkError) { if ((checkError as NodeJS.ErrnoException).code !== 'ESRCH') throw checkError }
      }
    }
    await fs.rm(lock, { recursive: true })
    await fs.mkdir(lock, { mode: 0o700 })
  }
  const owner = { owner_pid: process.pid, native_pid: 0, socket: '' }
  const record = async (pid: number, socket: string) => {
    owner.native_pid = pid; owner.socket = socket
    const temporary = join(lock, 'owner.json.tmp')
    await fs.writeFile(temporary, JSON.stringify(owner), { mode: 0o600 })
    await fs.rename(temporary, join(lock, 'owner.json'))
  }
  await record(0, '')
  return { record, release: () => fs.rm(lock, { recursive: true, force: true }) }
}

export async function terminateOwnedMacRuntime(pid: number, socket: string): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || !socket.includes('/crabot-cua-') || !socket.endsWith('/driver.sock')) throw new Error('COMPUTER_USE_RUNTIME_OWNERSHIP_INVALID')
  for (let i = 0; i < 20; i++) {
    if (!await commandLine(pid)) return
    await new Promise(done => setTimeout(done, 50))
  }
  const command = await commandLine(pid)
  if (!command) return
  if (!command.includes('CuaDriver.app/Contents/MacOS/cua-driver') || !command.includes(`--socket ${socket}`)) throw new Error('COMPUTER_USE_RUNTIME_OWNERSHIP_CHANGED')
  process.kill(pid, 'SIGKILL') // Only after argv proves the exact private runtime; used when cooperative stop failed.
  for (let i = 0; i < 40; i++) {
    if (!await commandLine(pid)) return
    await new Promise(done => setTimeout(done, 50))
  }
  throw new Error('COMPUTER_USE_RUNTIME_STOP_UNCONFIRMED')
}
