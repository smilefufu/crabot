import { build } from 'esbuild'
import { mkdir, copyFile } from 'node:fs/promises'
await build({ entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', bundle: true,
  platform: 'node', format: 'cjs', target: 'es2022', external: ['electron'], sourcemap: false })
await mkdir('dist/assets', { recursive: true })
await copyFile('assets/tray.png', 'dist/assets/tray.png')
