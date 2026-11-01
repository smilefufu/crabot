// Disposable CI probe: real compiled Agent -> PowerShell from a console-free Node owner.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
if (process.platform !== 'win32') process.exit(0)
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('Hosted CI only')
if (process.argv[2] === 'child') {
  const { runHostProcess } = await import(pathToFileURL(path.resolve('crabot-agent/dist/engine/host-process.js')).href)
  const powershell = path.join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const command = `Add-Type 'using System;using System.Runtime.InteropServices;public class ConsoleProbe{[DllImport("kernel32.dll")]public static extern IntPtr GetConsoleWindow();[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr hwnd);}';$h=[ConsoleProbe]::GetConsoleWindow();@{console=($h.ToInt64());visible=[ConsoleProbe]::IsWindowVisible($h)}|ConvertTo-Json -Compress`
  const value = await runHostProcess({ argv: [powershell, '-NoProfile', '-NonInteractive', '-Command', command],
    limits: { timeoutMs: 10000, stdoutBytes: 65536, stderrBytes: 65536 } })
  assert.equal(value.kind, 'exit', value.stderr); assert.equal(value.exitCode, 0, value.stderr)
  const observed = JSON.parse(value.stdout)
  assert.equal(observed.console, 0, 'Background tools must not allocate a console that Windows Terminal can host')
  assert.equal(observed.visible, false)
  process.send?.({ windows_background_tool_no_console: true })
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-hidden-host-'))
  const env = { ...process.env, DATA_DIR: root }; delete env.CRABOT_AGENT_DATA_DIR
  const child = fork(fileURLToPath(import.meta.url), ['child'], { env, execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let output = '', answer
  child.stdout.on('data', value => { output = (output + value).slice(-65536) })
  child.stderr.on('data', value => { output = (output + value).slice(-65536) })
  child.on('message', value => { answer = value })
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
  try {
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, output); assert.deepEqual(answer, { windows_background_tool_no_console: true })
    console.log(JSON.stringify(answer))
  } finally { clearTimeout(timer); child.kill('SIGKILL'); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }) }
}
