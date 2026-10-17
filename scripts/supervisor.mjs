#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createStream } from 'rotating-file-stream'
import { runManagedCore } from './lib/managed-core.mjs'

const dataDir = process.env.CRABOT_SUPERVISOR_DATA_DIR
const entry = process.env.CRABOT_SUPERVISOR_MM_ENTRY
if (!dataDir || !entry) throw new Error('supervisor: missing instance launch context')
const root = resolve(dirname(entry), '../..')
const logs = resolve(dataDir, 'logs')
mkdirSync(logs, { recursive: true })
const options = { path: logs, size: '10M', maxFiles: 5 }
const stdout = createStream('mm.stdout.log', options)
const stderr = createStream('mm.stderr.log', options)
const { mm } = await runManagedCore({
  root, dataDir, mmPort: 19000 + Number(process.env.CRABOT_PORT_OFFSET || 0),
  env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  log: message => stdout.write(message),
  cleanup: code => { stdout.end(); stderr.end(); process.exit(code) },
})
mm.stdout.pipe(stdout)
mm.stderr.pipe(stderr)
