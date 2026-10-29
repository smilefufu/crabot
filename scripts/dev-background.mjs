// Source GUI adapter only; uses the same dev producer and data/port policy.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDevelopment } from './lib/development.mjs'
await startDevelopment(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
