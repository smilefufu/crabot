import { app } from 'electron'
import updaterPackage from 'electron-updater'
import type { AppUpdater, UpdateDownloadedEvent, ProgressInfo } from 'electron-updater'
import { existsSync } from 'node:fs'
import { readFile, mkdir, statfs } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { UpdateDownload, UpdateDriver } from './update-dialog.js'
import { UpdateConfigSchema, UpdateInfoSchema, verifyUpdateDownload } from './update-package.js'

// Final packaging writes this controlled JSON (a YAML subset) for the updater.
// A candidate marker always disables the channel, even if config is copied in.
export async function createUpdateDriver(options: { resources: string; cacheRoot: string; packaged: boolean;
  beginExit: () => () => void }): Promise<UpdateDriver | null> {
  if (!options.packaged || existsSync(path.join(options.resources, 'candidate-only.json'))) return null
  const configFile = path.join(options.resources, 'app-update.yml')
  if (!existsSync(configFile)) throw new Error('Release update configuration is missing')
  const config = UpdateConfigSchema.parse(JSON.parse(await readFile(configFile, 'utf8')))
  if (process.platform === 'win32' && !config.publisherName?.length) throw new Error('Signed updater publisher is missing')
  if (process.platform === 'linux' && (await readFile(path.join(options.resources, 'package-type'), 'utf8')).trim() !== 'deb') throw new Error('Unsupported package updater')
  await mkdir(options.cacheRoot, { recursive: true, mode: 0o700 })
  const adapter = { version: app.getVersion(), name: 'Crabot', isPackaged: true, appUpdateConfigPath: configFile,
    userDataPath: app.getPath('userData'), baseCachePath: options.cacheRoot,
    whenReady: () => app.whenReady().then(() => {}), relaunch: () => app.relaunch(), quit: () => app.quit(),
    onQuit: (handler: (code: number) => void) => { app.on('quit', (_event, code) => handler(code)) } }
  const updater: AppUpdater = process.platform === 'darwin' ? new updaterPackage.MacUpdater(undefined, adapter)
    : process.platform === 'win32' ? new updaterPackage.NsisUpdater(undefined, adapter) : new updaterPackage.DebUpdater(undefined, adapter)
  updater.logger = null
  updater.autoDownload = false // Validate metadata first, then download automatically.
  updater.autoInstallOnAppQuit = false
  updater.autoRunAppAfterInstall = true
  updater.allowDowngrade = false
  updater.allowPrerelease = false
  updater.disableWebInstaller = true
  updater.on('error', () => { /* Handled by check/install promises; no raw URLs or response bodies in logs. */ })
  let downloaded: UpdateDownload | undefined
  return {
    async check(progress) {
      const result = await updater.checkForUpdates()
      if (!result?.isUpdateAvailable) return null
      const info = UpdateInfoSchema.parse(result.updateInfo)
      const needed = info.files.reduce((maximum, file) => Math.max(maximum, file.size), 0)
      const space = await statfs(options.cacheRoot, { bigint: true })
      // Reserve unpacking headroom; the stopped-data snapshot separately checks
      // its exact scope. Installer failures still retain the recovery fence.
      if (space.bavail * space.bsize < BigInt(needed) * 4n + 64n * 1024n * 1024n) throw new Error('Insufficient update space')
      let event: UpdateDownloadedEvent | undefined
      const receive = (value: UpdateDownloadedEvent) => { event = value }
      const report = (value: ProgressInfo) => progress(value.percent)
      updater.on('update-downloaded', receive); updater.on('download-progress', report)
      try {
        await updater.downloadUpdate(result.cancellationToken)
        if (!event || event.version !== info.version) throw new Error('Unconfirmed update download')
        const file = info.files.find(file => file.url === path.basename(event!.downloadedFile))
        if (!file) throw new Error('Unexpected update package')
        downloaded = { version: info.version, file: event.downloadedFile, sha512: file.sha512, size: file.size }
        await verifyUpdateDownload(downloaded)
        return { ...downloaded }
      } finally { updater.off('update-downloaded', receive); updater.off('download-progress', report) }
    },
    async install(update) {
      if (!downloaded || JSON.stringify(update) !== JSON.stringify(downloaded)) throw new Error('Unexpected update installation')
      await verifyUpdateDownload(update)
      if (process.platform === 'linux') {
        // Use the OS authorization prompt for this one verified package only.
        // No shell, broad apt repair, unsigned fallback, or automatic downgrade.
        await promisify(execFile)('/usr/bin/pkexec', ['/usr/bin/dpkg', '--install', update.file], { timeout: 600_000, maxBuffer: 1024 * 1024 })
        options.beginExit(); app.relaunch(); app.quit()
        return
      }
      const undo = options.beginExit()
      try {
        await new Promise<void>((resolve, reject) => {
          const done = () => { clearTimeout(timer); updater.off('error', error); app.off('before-quit', exiting) }
          const error = () => { done(); reject(new Error('Installer did not start')) }
          const exiting = () => { done(); resolve() }
          const timer = setTimeout(error, 180_000)
          updater.once('error', error); app.once('before-quit', exiting)
          try { updater.quitAndInstall(false, true) } catch { error() }
        })
      } catch (error) { undo(); throw error }
    },
  }
}
