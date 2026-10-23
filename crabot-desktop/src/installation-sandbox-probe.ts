import { app, BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'

// Isolated installation probe. It never resolves a Core, starts MM, connects
// Admin, grants application IPC or uses a persistent user/business profile.
export async function runInstallationSandboxProbe(argument: string) {
  let window: BrowserWindow | undefined
  const timer = setTimeout(() => app.exit(1), 45_000)
  try {
    if (process.platform !== 'linux' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[a-f0-9]{64}\/gui$/.test(argument)
      || Number(new URL(argument).port) > 65535 || process.argv.some(value => /^--(?:no-sandbox|disable-.*sandbox|single-process)(?:=|$)/.test(value))) throw new Error('Invalid installation probe')
    app.enableSandbox()
    await app.whenReady()
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true,
      webSecurity: true, webviewTag: false, allowRunningInsecureContent: false } })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => { if (url !== argument) event.preventDefault() })
    await window.loadURL(argument)
    const ready = await window.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100; i++) {
        if (document.body.dataset.ready === 'yes') return typeof process === 'undefined' && document.title === 'Crabot sandbox probe';
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    })()`)
    const pid = window.webContents.getOSProcessId()
    if (!ready || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('Renderer not ready')
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    if (!/^NoNewPrivs:\s+1$/m.test(status) || !/^Seccomp:\s+2$/m.test(status)
      || (await readFile(`/proc/${pid}/uid_map`, 'utf8')).trim() === (await readFile('/proc/self/uid_map', 'utf8')).trim()) throw new Error('Renderer sandbox not verified')
    window.destroy(); app.exit(0)
  } catch { window?.destroy(); app.exit(1) }
  finally { clearTimeout(timer) }
}
