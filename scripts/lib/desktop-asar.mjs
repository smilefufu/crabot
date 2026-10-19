// ASAR's lookup API splits using the host path separator. Keep all required
// entries checked on Windows as well as POSIX; the archive itself is portable.
import path from 'node:path'
export function verifyDesktopAsar(asar, archive, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  for (const file of ['dist/main.js', 'dist/preload.cjs', 'dist/bootstrap/scripts/lib/desktop-installation.cjs',
    'dist/bootstrap/scripts/lib/process-identity.cjs', 'dist/bootstrap/crabot-native/build/Release/crabot-native.node', 'dist/assets/tray.png', 'node_modules/crabot-client/dist/index.js',
    'node_modules/zod/package.json', 'node_modules/electron-updater/package.json']) asar.statFile(archive, paths.normalize(file))
}
