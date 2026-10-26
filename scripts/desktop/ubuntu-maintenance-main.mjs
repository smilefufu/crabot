// Fixed private-Node entry only. Never loaded by the finite preparation probe.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRemovalHostRequest } from './request.mjs'
import { runUbuntuRemovalHost } from './host.mjs'
try {
  const executable = fs.realpathSync(process.execPath), directory = path.dirname(executable)
  if (process.platform !== 'linux' || process.argv.length !== 3 || process.execArgv.length
    || fs.realpathSync(process.argv[1]) !== fileURLToPath(import.meta.url)
    || fileURLToPath(import.meta.url) !== path.join(directory, 'backend/main.mjs')) throw new Error('Invalid fixed maintenance entry')
  const request = readRemovalHostRequest([executable, process.argv[2]])
  if (!request) throw new Error('Missing maintenance request')
  await runUbuntuRemovalHost(request)
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'CRABOT_DESKTOP_REMOVAL'
  process.stderr.write(JSON.stringify({ component: 'desktop-removal', code }) + '\n')
  process.exitCode = 1
}
