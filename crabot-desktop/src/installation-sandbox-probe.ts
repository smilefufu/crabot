import { app, BrowserWindow } from 'electron'
import { readFile, lstat, mkdir } from 'node:fs/promises'
import path from 'node:path'

// Isolated installation probe. It never resolves a Core, starts MM, connects
// Admin, grants application IPC or uses a persistent user/business profile.
export async function runInstallationSandboxProbe(argument: string) {
  let window: BrowserWindow | undefined, stage = 'arguments'
  const timer = setTimeout(() => app.exit(1), 45_000)
  try {
    if (process.platform !== 'linux' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[a-f0-9]{64}\/gui$/.test(argument)
      || Number(new URL(argument).port) > 65535 || process.argv.some(value => /^--(?:no-sandbox|disable-.*sandbox|single-process)(?:=|$)/.test(value))) throw new Error('Invalid installation probe')
    stage = 'profile'
    const profiles = process.argv.filter(value => value.startsWith('--user-data-dir='))
    const profile = profiles[0]?.slice('--user-data-dir='.length)
    if (profiles.length !== 1 || !profile || !path.isAbsolute(profile)) throw new Error('Missing isolated profile')
    const stat = await lstat(profile)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700) throw new Error('Invalid isolated profile')
    app.setPath('userData', profile); app.setPath('sessionData', profile)
    await mkdir(path.join(profile, 'tmp'), { mode: 0o700 })
    app.setPath('temp', path.join(profile, 'tmp'))
    app.enableSandbox()
    stage = 'window'
    await app.whenReady()
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true,
      webSecurity: true, webviewTag: false, allowRunningInsecureContent: false } })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => { if (url !== argument) event.preventDefault() })
    stage = 'network'
    await window.loadURL(argument)
    const ready = await window.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100; i++) {
        if (document.body.dataset.ready === 'yes') return typeof process === 'undefined' && document.title === 'Crabot sandbox probe';
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    })()`)
    stage = 'renderer'
    const pid = window.webContents.getOSProcessId()
    if (!ready || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('Renderer not ready')
    stage = 'kernel'
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    const mapping = (await readFile(`/proc/${pid}/uid_map`, 'utf8')).trim()
    if (!mapping || !/^NoNewPrivs:\s+1$/m.test(status) || !/^Seccomp:\s+2$/m.test(status)
      || mapping === (await readFile('/proc/self/uid_map', 'utf8')).trim()) throw new Error('Renderer sandbox not verified')
    window.destroy(); app.exit(0)
  } catch { process.stderr.write('CRABOT_GUI_SANDBOX_PROBE_FAILED:' + stage + '\n'); window?.destroy(); app.exit(1) }
  finally { clearTimeout(timer) }
}
