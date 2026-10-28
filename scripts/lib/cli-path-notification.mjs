// A hung third-party window must not block a lifecycle lock or Electron's UI.
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
export async function notifyCliPathChange(coreRoot, env = process.env) {
  const helperEnv = Object.fromEntries(Object.entries(env).filter(([key]) => /^(SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA)$/i.test(key)))
  try {
    const { stdout } = await promisify(execFile)(path.join(coreRoot, '.product-runtime/node/node.exe'),
      ['-e', 'process.stdout.write(String(require(process.argv[1]).notifyUserPathChanged()))', path.join(coreRoot, 'scripts/lib/process-identity.cjs')],
      { env: helperEnv, timeout: 10_000, maxBuffer: 4096, windowsHide: true })
    return stdout === 'true'
  } catch { return false }
}
