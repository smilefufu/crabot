// Current GUI coordination only. Checking never stops a service or loads target code.
import type { DesktopReleaseManifest } from 'crabot-client/contracts'
import type { PreparedDesktopPair } from './controller.js'
import type { PreparedInstallation } from './installation-entries.js'
import type { createDesktopReleaseDownloader } from './release-download.js'
import type { createDesktopReleaseIntake } from './release-intake.js'
import type { PairedUpdateDownload, UpdateDriver } from './update-dialog.js'

type Downloader = ReturnType<typeof createDesktopReleaseDownloader>
type Download = NonNullable<Awaited<ReturnType<Downloader['check']>>>
const identity = (value: PreparedInstallation) => JSON.stringify([value.installRoot, value.installation_id, value.selection])
function fail(code: string): never { throw Object.assign(new Error('更新上下文已改变，原版本和维护记录保留。'), { code }) }

export function createPairedUpdateDriver(options: {
  platform: DesktopReleaseManifest['platform']; arch: DesktopReleaseManifest['arch']
  current: () => PreparedInstallation
  downloader: Pick<Downloader, 'check'>
  intake: ReturnType<typeof createDesktopReleaseIntake<PreparedDesktopPair>>
  preparePlatform: (prepared: PreparedDesktopPair, signal: AbortSignal) => Promise<void>
  apply: (prepared: PreparedDesktopPair) => Promise<{ executable: string; dataDir: string }>
  handoff: (target: { executable: string; dataDir: string }) => Promise<void>
}): UpdateDriver {
  let checked: { candidate: PairedUpdateDownload; download: Download; source: string } | undefined
  let checking = false, installing = false
  const abort = new AbortController()
  const requireSource = (source: string) => { if (identity(options.current()) !== source) fail('CRABOT_DESKTOP_INSTALLATION') }
  return {
    async check(progress) {
      abort.signal.throwIfAborted()
      if (checking || installing) fail('CRABOT_UPDATE_BUSY')
      checking = true
      try {
        const current = options.current(), source = identity(current)
        const download = await options.downloader.check(current.selection, { progress, signal: abort.signal })
        abort.signal.throwIfAborted(); requireSource(source)
        checked = download ? { candidate: Object.freeze({ kind: 'paired', version: download.manifest.selection.version }), download, source } : undefined
        return checked?.candidate ?? null
      } finally { checking = false }
    },
    async install(candidate) {
      abort.signal.throwIfAborted()
      if (checking || installing) fail('CRABOT_UPDATE_BUSY')
      if (!checked || candidate !== checked.candidate) fail('CRABOT_DESKTOP_RELEASE_SIGNATURE')
      installing = true
      const { download, source } = checked
      try {
        requireSource(source)
        const current = options.current()
        const stage = await options.intake.stage({ manifestBytes: download.manifestBytes, signatureBytes: download.signatureBytes,
          artifact: download.artifact, signal: abort.signal, context: { platform: options.platform, arch: options.arch, purpose: 'update', currentVersion: current.selection.version } })
        let prepared: PreparedDesktopPair
        try {
          abort.signal.throwIfAborted(); requireSource(source)
          prepared = await options.intake.prepare(stage, { installRoot: current.installRoot, signal: abort.signal })
        } finally { await options.intake.discard(stage) }
        // Final-path preparation has its own complete proof. Expanded transport
        // bytes are no longer needed; platform authorization precedes any stop.
        abort.signal.throwIfAborted(); requireSource(source)
        await options.preparePlatform(prepared, abort.signal)
        abort.signal.throwIfAborted(); requireSource(source)
        const target = await options.apply(prepared)
        await download.discard()
        await options.handoff(target)
        checked = undefined
      } finally { installing = false }
    },
    close() { abort.abort() },
  }
}
