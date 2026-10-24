// Actual current-GUI wiring. Trust roots are protected program resources; no
// renderer, environment setting or download can supply keys or executable paths.
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DesktopController, PreparedDesktopPair } from './controller.js'
import type { UpdateDriver } from './update-dialog.js'
import { replaceInstallationEntries, type PreparedInstallation } from './installation-entries.js'
import { createDesktopReleaseVerifier } from './release-signatures.js'
import { createDesktopReleaseDownloader } from './release-download.js'
import { createDesktopReleaseIntake } from './release-intake.js'
import { createPairedUpdateDriver } from './paired-update.js'
import { prepareUbuntuUpdate } from './ubuntu-update.js'
import { handoffDesktopPair } from './paired-handoff.js'
const require = createRequire(import.meta.url)
const installation = require('./bootstrap/scripts/lib/desktop-installation.cjs')
const product = require('./bootstrap/scripts/lib/product-runtime.cjs')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function fail(): never { throw Object.assign(new Error('Desktop update installation changed'), { code: 'CRABOT_DESKTOP_INSTALLATION' }) }
type Transport = { fetch: Parameters<typeof createDesktopReleaseDownloader>[0]['fetch']; close: () => Promise<void> }

export async function createPairedUpdateHost(options: {
  pinnedPublicKeys: readonly string[]; coreRoot: string; dataRoot: string; appVersion: string; verifyBinding?: () => void
  controller: Pick<DesktopController, 'applyPreparedPair'>
  entries: Parameters<typeof replaceInstallationEntries>[2]
  transport: () => Transport
  app: Parameters<typeof handoffDesktopPair>[0]['app']; beginExit: () => () => void
}): Promise<UpdateDriver | null> {
  if (!options.pinnedPublicKeys.length) return null
  const keys = Object.freeze([...options.pinnedPublicKeys])
  createDesktopReleaseVerifier(keys)
  let closed = false, initializing: Promise<UpdateDriver> | undefined, paired: UpdateDriver | undefined, transport: Transport | undefined
  const active = () => { if (closed) throw new DOMException('Cancelled', 'AbortError') }
  const closeTransport = () => { const owned = transport; transport = undefined; void owned?.close().catch(() => {}) }
  async function initialize(): Promise<UpdateDriver> {
    active()
    options.verifyBinding?.()
    const platform = process.platform, arch = process.arch
    if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux' || arch !== 'arm64' && arch !== 'x64'
      || platform !== 'darwin' && arch !== 'x64' || options.entries.platform !== platform) fail()
    const source = installation.locateDesktopCore(options.coreRoot)
    if (!source || source.dataDir !== options.dataRoot || source.selection.version !== options.appVersion) fail()
    const current = (): PreparedInstallation => {
      active(); options.verifyBinding?.()
      const own = installation.locateDesktopCore(options.coreRoot)
      if (!own || own.root !== source.root || !same(own.record, source.record) || own.dataDir !== source.dataDir || !same(own.selection, source.selection)) fail()
      return { installRoot: own.root, installation_id: own.record.installation_id, selection: own.selection, coreRoot: own.coreRoot, guiRoot: own.guiRoot }
    }
    current()
    const { verifyCoreRelease } = await import(new URL('./bootstrap/scripts/lib/core-release.mjs', import.meta.url).href)
    const release = await verifyCoreRelease(source.coreRoot, { version: source.selection.version })
    if (release.inventory_sha256 !== source.selection.core_id) fail()
    current()
    // Source modules and the extraction interpreter are used only after their
    // complete current Core has passed the protected verifier.
    const load = (file: string) => import(pathToFileURL(path.join(source.coreRoot, 'scripts/lib', file)).href)
    const [payload, preparation, locks, maintenance, commit] = await Promise.all([
      load('desktop-payload.mjs'), load('desktop-pair-preparation.mjs'), load('cli-lock.mjs'), load('version-maintenance.mjs'), load('desktop-pair-commit.mjs'),
    ])
    current()
    const runtime = product.loadProductRuntime(source.coreRoot, { required: true })
    const cache = path.join(options.dataRoot, 'runtime-cache')
    transport = options.transport()
    try {
      active()
      const downloader = createDesktopReleaseDownloader({ pinnedPublicKeys: keys, platform, arch,
        cacheRoot: path.join(cache, 'release-downloads'), fetch: transport.fetch })
      const intake = createDesktopReleaseIntake<PreparedDesktopPair>({ pinnedPublicKeys: keys, python: runtime.executables.python,
        cacheRoot: path.join(cache, 'release-intake'), verifyPayload: payload.verifyDesktopPayload, preparePair: preparation.prepareDesktopPair })
      let committed: PreparedDesktopPair | undefined
      async function verifyHandoff(requested: { executable: string; dataDir: string }) {
        active()
        const expected = committed
        if (!expected) fail()
        // Source selection has deliberately changed. Check the committed target
        // under the original common lock instead of reusing the source pin gate.
        const lock = await locks.acquireStartupLock(options.dataRoot, 'desktop-paired-handoff')
        try {
          const record = maintenance.readVersionMaintenance(options.dataRoot)
          const selectedPair = await commit.readCommittedDesktopPair(source.root, record?.id)
          if (!same(selectedPair, { installRoot: expected.installRoot, installation_id: expected.installation_id, source: expected.source,
            selection: expected.selection, coreRoot: expected.coreRoot, guiRoot: expected.guiRoot, proof: expected.proof })) fail()
          const selected = installation.readDesktopSelection(source.root)
          active()
          if (selected.dataDir !== requested.dataDir || selected.executable !== requested.executable) fail()
        } finally { locks.releaseCliLock(lock) }
      }
      paired = createPairedUpdateDriver({ platform, arch, current, downloader, intake,
        preparePlatform: async (prepared, signal) => {
          const verifyPrograms = async () => {
            current(); await preparation.verifyPreparedDesktopPair(prepared); current()
            return product.loadProductRuntime(prepared.coreRoot, { required: true, full: true })
          }
          if (platform === 'linux') await prepareUbuntuUpdate(prepared, { signal, verifyPrograms })
          else { signal.throwIfAborted(); await verifyPrograms(); signal.throwIfAborted() }
        },
        apply: async prepared => {
          const target = await options.controller.applyPreparedPair(prepared, (from, to) => replaceInstallationEntries(from, to, options.entries))
          committed = prepared
          return target
        },
        handoff: target => handoffDesktopPair({ target, app: options.app, beginExit: options.beginExit, verify: verifyHandoff }),
      })
      return paired
    } catch (error) { closeTransport(); throw error }
  }
  const driver = () => { active(); return initializing ??= initialize() }
  return {
    async check(progress) { return (await driver()).check(progress) },
    async install(candidate) { return (await driver()).install(candidate) },
    close() { closed = true; paired?.close?.(); closeTransport() },
  }
}
