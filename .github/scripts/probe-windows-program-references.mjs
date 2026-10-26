// Finite diagnostic only. No application, business state, services or OS policy.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import identity from '../../scripts/lib/process-identity.cjs'
if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32') throw new Error('Requires disposable Windows CI')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crabot-reference-scale-')), files = []
try {
  for (let i = 0; i < 8192; i++) { const file = path.join(root, 'resource-' + i + '.txt'); fs.writeFileSync(file, 'x', { flag: 'wx' }); files.push(file) }
  for (const count of [0, 1, 64, 512, 4096, 8192]) {
    const start = performance.now(), result = await identity.inspectProgramReferences({ roots: [root], files: files.slice(0, count) })
    console.log('CRABOT_WINDOWS_REFERENCE_SCALE ' + JSON.stringify({ count, elapsed_ms: Math.round(performance.now() - start), ...result }))
    if (count === 0) assert.equal(result.complete, true)
  }
  const code = 'const fs=require("node:fs");const fd=fs.openSync(process.argv[1],"r");process.stdout.write("ready\\n");process.stdin.once("data",()=>{fs.closeSync(fd);process.exit(0)})'
  const child = spawn(process.execPath, ['-e', code, files[0]], { stdio: ['pipe', 'pipe', 'pipe'] }), exited = once(child, 'close')
  try {
    await once(child.stdout, 'data')
    const held = await identity.inspectProgramReferences({ roots: [root], files: [files[0]] })
    console.log('CRABOT_WINDOWS_REFERENCE_HELD ' + JSON.stringify(held)); assert.equal(held.processes.some(item => item.pid === child.pid), true)
    child.stdin.end('close'); assert.equal((await exited)[0], 0)
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } }
} finally { fs.rmSync(root, { recursive: true }) }
