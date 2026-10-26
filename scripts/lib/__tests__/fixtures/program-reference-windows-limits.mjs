// Finite real Windows resources. No application, business state, services or OS policy.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import identity from '../../process-identity.cjs'
if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32') throw new Error('Requires disposable Windows CI')
export async function verifyWindowsResourceLimits() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crabot-reference-scale-')), files = []
  try {
    for (let i = 0; i < 65536; i++) { const file = path.join(root, 'resource-' + i + '.txt'); fs.writeFileSync(file, 'x', { flag: 'wx' }); files.push(file) }
    for (const count of [0, 1, 64, 512, 4096, 8192, 32768, 65536]) {
      const start = performance.now(), result = await identity.inspectProgramReferences({ roots: [root], files: files.slice(0, count) })
      console.log('CRABOT_WINDOWS_REFERENCE_SCALE ' + JSON.stringify({ count, elapsed_ms: Math.round(performance.now() - start), ...result }))
      assert.equal(result.complete, true, JSON.stringify({ count, ...result }))
    }
    const longDirectory = path.join(root, ...Array.from({ length: 3 }, (_, i) => '项目 空间 ' + i + '-' + 'x'.repeat(90)))
    fs.mkdirSync(longDirectory, { recursive: true }); const longFile = path.join(longDirectory, 'resource.txt'); fs.writeFileSync(longFile, 'x')
    for (const [kind, file] of [['long-path', longFile], ['long-namespaced', path.toNamespacedPath(longFile)]]) {
      const start = performance.now(), result = await identity.inspectProgramReferences({ roots: [root], files: [file] })
      console.log('CRABOT_WINDOWS_REFERENCE_PATH ' + JSON.stringify({ kind, characters: file.length, elapsed_ms: Math.round(performance.now() - start), ...result }))
      assert.equal(result.complete, true, JSON.stringify({ kind, ...result }))
    }
    const junction = path.join(root, 'directory-link'); fs.symlinkSync(longDirectory, junction, 'junction')
    for (const [kind, file] of [['directory', longDirectory], ['directory-link', junction]]) {
      const result = await identity.inspectProgramReferences({ roots: [root], files: [file] })
      console.log('CRABOT_WINDOWS_REFERENCE_PATH ' + JSON.stringify({ kind, ...result }))
      assert.equal(result.complete, false, 'Directories are not Restart Manager file resources')
    }
    const code = 'const fs=require("node:fs");const fd=fs.openSync(process.argv[1],"r");process.stdout.write("ready\\n");process.stdin.once("data",()=>{fs.closeSync(fd);process.exit(0)})'
    for (const [kind, heldFile, resources] of [['ordinary', files[0], [files[0]]], ['long', longFile, [longFile]], ['last-group', files.at(-1), files]]) {
      const child = spawn(process.execPath, ['-e', code, heldFile], { stdio: ['pipe', 'pipe', 'pipe'] }), exited = once(child, 'close')
      try {
        await once(child.stdout, 'data')
        const held = await identity.inspectProgramReferences({ roots: [root], files: resources })
        console.log('CRABOT_WINDOWS_REFERENCE_HELD ' + JSON.stringify({ kind, ...held }))
        assert.equal(held.complete, true, JSON.stringify({ kind, ...held }))
        assert.equal(held.processes.some(item => item.pid === child.pid), true)
        child.stdin.end('close'); assert.equal((await exited)[0], 0)
      } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } }
    }
  } finally { fs.rmSync(root, { recursive: true }) }
}
