// Build-time fixed code only. No Core, environment, data or removal job is copied.
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { desktopMaintenanceBootstrap, desktopMaintenanceNodeFiles } from '../lib/desktop-maintenance-bootstrap.mjs'
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(repository, 'crabot-desktop/package.json'))
export async function buildUbuntuMaintenanceBackend(output) {
  output = path.resolve(output)
  // The caller supplies a fresh candidate directory. Never erase an old output.
  await fs.mkdir(output)
  for (const name of [...desktopMaintenanceBootstrap, 'crabot-native/build/Release/crabot-native.node']) {
    const target = path.join(output, 'bootstrap', name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(path.join(repository, name), target)
  }
  const { build } = require('esbuild')
  await build({ entryPoints: [path.join(repository, 'crabot-desktop/src/ubuntu-removal-progress.ts')], outfile: path.join(output, 'progress.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: false, logLevel: 'silent' })
  await build({ entryPoints: [path.join(repository, 'crabot-desktop/src/ubuntu-removal-rules.ts')], outfile: path.join(output, 'rules.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: false, logLevel: 'silent' })
  await build({ entryPoints: [path.join(repository, 'crabot-desktop/src/installation-removal.ts')], outfile: path.join(output, 'entries.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: false, logLevel: 'silent' })
  await build({ entryPoints: [path.join(repository, 'crabot-desktop/src/removal-operation.ts')], outfile: path.join(output, 'operation.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: false, logLevel: 'silent' })
  for (const [entry, file] of [['removal-request', 'request'], ['ubuntu-removal-host', 'host']]) await build({
    entryPoints: [path.join(repository, 'crabot-desktop/src/' + entry + '.ts')], outfile: path.join(output, file + '.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: false, logLevel: 'silent' })
  await fs.copyFile(path.join(repository, 'scripts/desktop/ubuntu-maintenance-main.mjs'), path.join(output, 'main.mjs'))
  const asarVersion = require('@electron/asar/package.json').version
  if (asarVersion !== '3.4.1') throw new Error('Unexpected maintenance archive dependency version')
  const asar = path.join(output, 'node_modules/@electron/asar')
  await fs.mkdir(asar, { recursive: true })
  await build({ entryPoints: [require.resolve('@electron/asar')], outfile: path.join(asar, 'index.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['original-fs'], sourcemap: false, logLevel: 'silent' })
  await fs.writeFile(path.join(asar, 'package.json'), JSON.stringify({ name: '@electron/asar', version: asarVersion, main: 'index.cjs' }) + '\n', { flag: 'wx' })
  const generated = []
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile()) generated.push(path.relative(output, file).split(path.sep).join('/'))
      else throw new Error('Unexpected fixed maintenance resource')
    }
  }
  await walk(output)
  if (generated.sort().join('\n') !== [...desktopMaintenanceNodeFiles].sort().join('\n')) throw new Error('Fixed Node maintenance resource list changed')
  return output
}
