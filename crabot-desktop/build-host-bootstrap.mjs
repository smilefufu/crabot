import { mkdir, copyFile } from 'node:fs/promises'
import path from 'node:path'

// Fixed dependencies of these internal host components; no application entry yet.
for (const file of ['scripts/lib/desktop-installation.cjs', 'scripts/lib/desktop-management.cjs',
  'scripts/lib/desktop-removal-record.cjs', 'scripts/lib/process-identity.cjs', 'crabot-native/build/Release/crabot-native.node']) {
  const destination = path.join('dist/bootstrap', file)
  await mkdir(path.dirname(destination), { recursive: true })
  await copyFile(path.join('..', file), destination)
}
