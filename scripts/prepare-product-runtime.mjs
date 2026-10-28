#!/usr/bin/env node
// Build-time only. Desktop installers consume the already prepared resources.
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareProductRuntime } from './lib/product-prepare.mjs'
import product from './lib/product-runtime.cjs'

const args = process.argv.slice(2)
const value = key => args.find(arg => arg.startsWith(key + '='))?.slice(key.length + 1)
const root = resolve(value('--root') ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
try {
  if (args.includes('--check')) {
    product.loadProductRuntime(root, { required: true, full: true })
  } else {
    await prepareProductRuntime(root, { version: value('--version') ?? 'desktop-dev', signal: controller.signal })
  }
} catch (error) {
  console.error('[crabot] Product runtime preparation failed: ' + error.message)
  process.exitCode = 1
}
