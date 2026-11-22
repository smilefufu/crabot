#!/usr/bin/env node
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolveCliDataDir } from './lib/instance.mjs'
import { prepareSourceNative } from './lib/source-native.mjs'

try {
  await prepareSourceNative(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  await import('./ui-upgrade-main.mjs')
} catch (error) {
  console.error('[ui-upgrade]', error.message)
  try {
    const directory = join(resolveCliDataDir({ homeDir: resolve(homedir(), '.crabot') }), 'admin')
    const file = join(directory, 'upgrade-status.json')
    let previous = {}
    try { previous = JSON.parse(readFileSync(file, 'utf8')) } catch {}
    mkdirSync(directory, { recursive: true })
    writeFileSync(file, JSON.stringify({ ...previous, phase: 'failed', error: `准备阶段失败，服务未停：${error.message}`, finished_at: new Date().toISOString() }, null, 2))
  } catch (statusError) { console.error('[ui-upgrade] status:', statusError.message) }
  process.exitCode = 1
}
