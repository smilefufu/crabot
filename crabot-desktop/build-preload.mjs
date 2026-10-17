import { build } from 'esbuild'
await build({ entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', bundle: true,
  platform: 'node', format: 'cjs', target: 'es2022', external: ['electron'], sourcemap: false })
