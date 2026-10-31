import { build } from 'esbuild'
import { mkdir, copyFile, rm } from 'node:fs/promises'
import { desktopMaintenanceBootstrap } from '../scripts/lib/desktop-maintenance-bootstrap.mjs'
await build({ entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', bundle: true,
  platform: 'node', format: 'cjs', target: 'es2022', external: ['electron'], sourcemap: false })
await mkdir('dist/assets', { recursive: true })
await copyFile('assets/tray.png', 'dist/assets/tray.png')

// Keep fixed maintenance code independent of Core and previous build leftovers.
await rm('dist/bootstrap', { recursive: true, force: true })
for (const file of [...desktopMaintenanceBootstrap, 'scripts/lib/desktop-first-launch.mjs', 'scripts/desktop/extract-paired-release.py', 'crabot-native/build/Release/crabot-native.node']) {
  const destination = 'dist/bootstrap/' + file
  await mkdir(destination.slice(0, destination.lastIndexOf('/')), { recursive: true })
  await copyFile('../' + file, destination)
}

for (const kind of ['installer', 'removal']) await build({ entryPoints: ['src/' + kind + '-preload.ts'], outfile: 'dist/' + kind + '-preload.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'es2022', external: ['electron'], sourcemap: false })
