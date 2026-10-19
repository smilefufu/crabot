import { build } from 'esbuild'
import { mkdir, copyFile } from 'node:fs/promises'
await build({ entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', bundle: true,
  platform: 'node', format: 'cjs', target: 'es2022', external: ['electron'], sourcemap: false })
await mkdir('dist/assets', { recursive: true })
await copyFile('assets/tray.png', 'dist/assets/tray.png')

// Keep the installation verifier beside the GUI, independent of the selected Core.
for (const file of ['scripts/lib/desktop-installation.cjs', 'scripts/lib/process-identity.cjs', 'crabot-native/build/Release/crabot-native.node']) {
  const destination = 'dist/bootstrap/' + file
  await mkdir(destination.slice(0, destination.lastIndexOf('/')), { recursive: true })
  await copyFile('../' + file, destination)
}

await build({ entryPoints: ['src/installer-preload.ts'], outfile: 'dist/installer-preload.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'es2022', external: ['electron'], sourcemap: false })
