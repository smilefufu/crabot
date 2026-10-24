// ASAR's lookup API splits using the host path separator. Keep all required
// entries checked on Windows as well as POSIX; the archive itself is portable.
import path from 'node:path'
import physicalFs from './physical-fs.cjs'
import { desktopMaintenanceBootstrap } from './desktop-maintenance-bootstrap.mjs'
const operationProgressFiles = ['dist/operation-progress-window.js', 'dist/operation-progress.js', 'dist/removal-progress-window.js', 'dist/removal-preload.cjs']
export function verifyDesktopPairAsar(asar, archive, selection, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  try {
    // Bound allocation before the official parser reads a claimed header length.
    const fd = physicalFs.openSync(archive, 'r')
    try {
      const stat = physicalFs.fstatSync(fd), prefix = Buffer.alloc(8)
      if (!stat.isFile() || physicalFs.readSync(fd, prefix, 0, 8, 0) !== 8
        || prefix.readUInt32LE(4) > 64 * 1024 * 1024 || prefix.readUInt32LE(4) > stat.size - 8) throw new Error('Invalid ASAR header bounds')
    } finally { physicalFs.closeSync(fd) }
    const file = paths.normalize('dist/desktop-release.json'), info = asar.statFile(archive, file, false)
    if (info.unpacked || 'link' in info || 'files' in info || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > 65_536
      || asar.extractFile(archive, file, false).toString('utf8') !== JSON.stringify(selection) + '\n') throw new Error('Invalid GUI pair pin')
  } catch {
    throw Object.assign(new Error('GUI归档中的版本对声明无法核验。'), { code: 'CRABOT_CORE_INTEGRITY' })
  }
}
export function verifyDesktopAsar(asar, archive, platform = process.platform, selection) {
  if (selection) verifyDesktopPairAsar(asar, archive, selection, platform)
  const paths = platform === 'win32' ? path.win32 : path.posix
  for (const file of desktopMaintenanceBootstrap) asar.statFile(archive, paths.normalize('dist/bootstrap/' + file))
  for (const file of operationProgressFiles) asar.statFile(archive, paths.normalize(file))
  for (const file of ['dist/main.js', 'dist/preload.cjs', 'dist/ubuntu-process.js', 'dist/ubuntu-program-probe.js', 'dist/ubuntu-update.js', 'dist/paired-update.js', 'dist/release-intake.js', 'dist/release-signatures.js', 'dist/release-download.js', 'dist/release-transport.js',
    'dist/bootstrap/scripts/lib/desktop-management.cjs', 'dist/bootstrap/scripts/desktop/extract-paired-release.py', 'dist/bootstrap/scripts/lib/desktop-installation.cjs', 'dist/bootstrap/scripts/lib/desktop-removal-record.cjs',
    'dist/bootstrap/scripts/lib/core-release.mjs', 'dist/bootstrap/scripts/lib/physical-fs.cjs',
    'dist/bootstrap/scripts/lib/process-identity.cjs', 'dist/bootstrap/crabot-native/build/Release/crabot-native.node', 'dist/assets/tray.png', 'node_modules/crabot-client/dist/index.js',
    'node_modules/zod/package.json', 'node_modules/electron-updater/package.json', 'node_modules/@electron/asar/package.json']) asar.statFile(archive, paths.normalize(file))
}

export function verifyInstallerAsar(asar, archive, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  for (const file of desktopMaintenanceBootstrap) asar.statFile(archive, paths.normalize('dist/bootstrap/' + file))
  for (const file of operationProgressFiles) asar.statFile(archive, paths.normalize(file))
  for (const file of ['dist/installer-main.js', 'dist/installer-preload.cjs', 'dist/installation-progress-window.js', 'dist/installation-entries.js',
    'dist/bootstrap/scripts/lib/desktop-payload.mjs', 'dist/bootstrap/scripts/lib/desktop-preparation-files.mjs', 'dist/bootstrap/scripts/lib/desktop-repair.mjs', 'dist/bootstrap/scripts/lib/desktop-program-proof.mjs', 'dist/bootstrap/scripts/lib/desktop-removal-proof.mjs', 'dist/bootstrap/scripts/lib/desktop-removal-host.mjs', 'dist/bootstrap/scripts/lib/module-process-start.cjs', 'dist/bootstrap/scripts/lib/instance-controller.mjs', 'dist/bootstrap/scripts/lib/desktop-removal-record.cjs', 'dist/bootstrap/scripts/lib/core-release.mjs', 'dist/bootstrap/scripts/lib/physical-fs.cjs', 'dist/bootstrap/scripts/lib/process-identity.cjs',
    'dist/bootstrap/crabot-native/build/Release/crabot-native.node', 'node_modules/crabot-client/dist/index.js', 'node_modules/zod/package.json', 'node_modules/@electron/asar/package.json']) asar.statFile(archive, paths.normalize(file))
}
