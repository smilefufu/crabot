import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { prepareSharedRequests } from './upgrade-lib/shared-requests.mjs'
const dataRoot = process.argv.find(value => value.startsWith('--data-dir='))?.slice('--data-dir='.length)
if (!dataRoot) throw new Error('Missing --data-dir')
await prepareSharedRequests(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), path.resolve(dataRoot))
