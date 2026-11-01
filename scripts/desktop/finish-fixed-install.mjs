// Program-install boundary only. No data creation, service stop/start or migration.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import installation from '../lib/desktop-installation.cjs'
import identity from '../lib/process-identity.cjs'
import management from '../lib/desktop-management.cjs'
import { privateJson } from '../lib/desktop-preparation-files.mjs'
import { verifyDesktopPrograms } from '../lib/desktop-payload.mjs'

export async function finishFixedDesktopInstall(root, { verify = verifyDesktopPrograms } = {}) {
  root = await fs.realpath(root)
  const guiRoot = path.join(root, 'program/gui'), coreRoot = path.join(root, 'program/core')
  const record = JSON.parse(await fs.readFile(path.join(root, 'program/desktop-payload.json'), 'utf8'))
  await verify(coreRoot, guiRoot, record)
  const metadata = path.join(root, 'desktop-installation.json')
  let before
  try { await fs.lstat(metadata); before = installation.readDesktopInstallation(root) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!before) return // First use alone chooses/initializes data and claims the installation UUID.
  const reference = installation.readDesktopPairReference(root)
  const source = installation.desktopProgramPaths(root, reference.selection, before.record)
  const executable = path.join(guiRoot, process.platform === 'win32' ? 'Crabot.exe' : 'crabot-desktop')
  if (process.platform === 'win32') {
    const oldExecutable = path.join(source.guiRoot, 'Crabot.exe')
    if (oldExecutable !== executable && identity.inspectDesktopLoginStartup(oldExecutable) === 'background') {
      identity.retargetDesktopLoginStartup(oldExecutable, executable)
    }
    identity.replaceDesktopUninstallEntry(before.record.installation_id,
      { installRoot: root, executable: oldExecutable, version: reference.selection.version },
      { installRoot: root, executable, version: record.selection.version })
  }
  const proofs = management.ensurePrivateDataRoot(path.join(root, 'app/payloads'))
  const proof = path.join(proofs, record.selection.gui_id + '.json')
  try {
    if (await fs.readFile(proof, 'utf8') !== JSON.stringify(record) + '\n') throw new Error('Installed payload record changed')
  } catch (error) { if (error.code !== 'ENOENT') throw error; await privateJson(proof, record) }
  await privateJson(metadata, { ...before.record, paths: { ...before.record.paths, app: 'program/gui', core: 'program/core' } }, true)
  if (await fs.lstat(path.join(root, '.desktop-removal.json')).catch(error => { if (error.code !== 'ENOENT') throw error; return null })) return
  const actual = installation.readDesktopSelection(root)
  if (actual.coreRoot !== coreRoot || actual.selection.version !== record.selection.version || actual.dataDir !== before.dataDir) {
    throw new Error('Installed program/data binding changed')
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected the selected installation root')
    await finishFixedDesktopInstall(process.argv[2])
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
