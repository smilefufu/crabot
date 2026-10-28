import { mkdir, copyFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { desktopMaintenanceBootstrap } from '../scripts/lib/desktop-maintenance-bootstrap.mjs'

await rm('dist/bootstrap', { recursive: true, force: true })
for (const file of [...desktopMaintenanceBootstrap, 'scripts/desktop/extract-paired-release.py', 'crabot-native/build/Release/crabot-native.node']) {
  const destination = path.join('dist/bootstrap', file)
  await mkdir(path.dirname(destination), { recursive: true })
  await copyFile(path.join('..', file), destination)
}
