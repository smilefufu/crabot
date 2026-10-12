import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { NATIVE_TOOLS, DRIVER_VERSION, type NativeDriver } from './types.js'

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((done, fail) => execFile(command, args, { env, timeout: 15_000 }, error => error ? fail(error) : done()))
}

/** Owns only a private runtime. Never adopts or stops the user's default Driver daemon. */
export async function createNativeDriver(root: string): Promise<NativeDriver> {
  const runtime = require(resolve(root, 'scripts/lib/computer-use-runtime.cjs')).loadRuntime(root)
  if (runtime.version !== DRIVER_VERSION) throw new Error('COMPUTER_USE_RUNTIME_MISMATCH')
  if (process.platform === 'linux' && (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) throw new Error('COMPUTER_USE_INTERACTIVE_SESSION_REQUIRED')
  const directory = await fs.mkdtemp(join(tmpdir(), 'crabot-cua-'))
  await fs.chmod(directory, 0o700)
  const socket = join(directory, 'driver.sock')
  const pidFile = join(directory, 'driver.pid')
  const policyFile = join(directory, 'policy.yaml')
  const allow = [...NATIVE_TOOLS, 'start_session', 'end_session', 'health_report', 'check_permissions']
  await fs.writeFile(policyFile, `allow:\n  tools:\n${allow.map(tool => `    - ${tool}`).join('\n')}\n`, { mode: 0o600 })
  const env = { ...process.env, CUA_DRIVER_PERMISSION_MODE: 'standard', CUA_TELEMETRY: '0', CUA_DRIVER_RS_TELEMETRY_ENABLED: '0', CUA_DRIVER_MANAGED_POLICY_FILE: policyFile }
  const client = new Client({ name: 'crabot-computer-use-host', version: '1.0.0' }, { capabilities: {} })
  let closed = false
  async function close(): Promise<void> {
    if (closed) return
    closed = true
    await client.close().catch(() => {})
    if (process.platform === 'darwin') {
      const pid = Number(await fs.readFile(pidFile, 'utf8').catch(() => ''))
      if (Number.isInteger(pid) && pid > 0) {
        await run(runtime.command, ['stop', '--socket', socket, '--expected-pid', String(pid)], env)
        for (let i = 0; i < 100; i++) {
          try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') break; throw error }
          if (i === 99) throw new Error('COMPUTER_USE_RUNTIME_STOP_UNCONFIRMED')
          await new Promise(done => setTimeout(done, 50))
        }
      }
    }
    await fs.rm(directory, { recursive: true, force: true })
  }
  try {
    let args: string[]
    if (process.platform === 'darwin') {
      await run('codesign', ['--verify', '--deep', '--strict', runtime.app])
      await run('open', ['-n', '-g', '--env', 'CUA_TELEMETRY=0', '--env', 'CUA_DRIVER_RS_TELEMETRY_ENABLED=0',
        '--env', `CUA_DRIVER_MANAGED_POLICY_FILE=${policyFile}`, runtime.app, '--args', 'serve', '--socket', socket,
        '--pid-file', pidFile, '--permission-mode', 'standard', '--no-overlay'])
      for (let i = 0; !await fs.stat(socket).then(() => true, () => false); i++) {
        if (i >= 100) throw new Error('COMPUTER_USE_RUNTIME_START_TIMEOUT')
        await new Promise(done => setTimeout(done, 100))
      }
      args = ['mcp', '--socket', socket, '--no-overlay']
    } else args = ['mcp', '--direct', '--no-overlay']
    await client.connect(new StdioClientTransport({ command: runtime.command, args,
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)), stderr: 'pipe' }))
    if (process.platform === 'darwin') {
      const permission = await client.callTool({ name: 'check_permissions', arguments: {} }, undefined, { timeout: 5_000 })
      if (permission.isError) throw new Error('COMPUTER_USE_OS_PERMISSIONS_REQUIRED')
    }
    return {
      async tools() { return (await client.listTools()).tools },
      async call(name, arguments_, signal) { return await client.callTool({ name, arguments: arguments_ }, undefined, { signal, timeout: 60_000 }) as Awaited<ReturnType<NativeDriver['call']>> },
      close,
    }
  } catch (error) { await close(); throw error }
}
