import { resolve } from 'node:path'
import { prepareMemoryDependencies } from './lib/memory-deps.mjs'
await prepareMemoryDependencies(resolve(process.argv[2]), { dev: process.argv.includes('--dev') })
