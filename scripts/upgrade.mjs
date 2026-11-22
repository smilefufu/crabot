#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSourceNative } from './lib/source-native.mjs'

try {
  await prepareSourceNative(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  await import('./upgrade-main.mjs')
} catch (error) {
  console.error('[upgrade]', error.message)
  process.exitCode = 1
}
