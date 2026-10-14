import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyReleasePackage } from './lib/release-package.mjs'
await verifyReleasePackage(resolve(dirname(fileURLToPath(import.meta.url)), '..'), process.argv[2])
console.log('[crabot] Release package verified')
