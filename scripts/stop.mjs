#!/usr/bin/env node
import './_preflight.mjs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { resolveCliDataDir } from './lib/instance.mjs'
import { acquireCliLock, releaseCliLock, hasInheritedCliLock } from './lib/cli-lock.mjs'
import { stopInstance } from './lib/instance-controller.mjs'

const dataDir = resolveCliDataDir({ homeDir: resolve(homedir(), '.crabot') })
let lock
try {
  if (!hasInheritedCliLock(dataDir)) lock = await acquireCliLock(dataDir, 'stop')
  await stopInstance(dataDir, { log: message => console.log(`[crabot] ${message}`) })
} catch (error) {
  console.error(`[crabot] ${error.message}`)
  process.exitCode = 1
} finally { releaseCliLock(lock) }
