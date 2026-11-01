// Disposable CI diagnosis: compare the same official tool and commands under
// full/filtered environments and visible/hidden console creation. No Slack login.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cliEnvironment, ensureCli } from '../../crabot-channel-slack/dist/cli-tools.js'
assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-startup-probe-'))
const run = promisify(execFile), system = path.join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32')
const wrapper = path.resolve('crabot-native/build/Release/crabot-hidden-console.exe')
async function inspect(executable, args, env, style, input) {
  const child = spawn(style === 'wrapper' ? wrapper : executable, style === 'wrapper' ? [executable, ...args] : args, {
    cwd: root, env, windowsHide: style !== 'normal', stdio: [input, 'pipe', 'pipe'],
  })
  child.stdin?.end()
  let output = '', error = '', exited = false, timedOut = false, timer
  child.stdout.on('data', bytes => { output += bytes.toString() })
  child.stderr.on('data', bytes => { error += bytes.toString() })
  child.once('exit', () => { exited = true })
  return await new Promise(resolve => {
    const finish = value => { clearTimeout(timer); resolve(value) }
    child.once('error', error => finish({ spawn_error: error.code }))
    child.once('close', code => finish({ code, output: output.slice(0, 2000), error: error.slice(0, 500), exited, timed_out: timedOut }))
    timer = setTimeout(async () => {
      timedOut = true
      const observed = { timeout: true, exited, output: output.slice(0, 2000), error: error.slice(0, 500) }
      if (!exited) await run(path.join(system, 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }).catch(() => {})
      child.stdout.destroy(); child.stderr.destroy()
      finish(observed)
    }, 5000)
  })
}
try {
  const official = await ensureCli(root, AbortSignal.timeout(120000))
  const compiler = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe')
  const { stdout } = await run(compiler, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'])
  const source = path.join(root, 'console.cc'), probe = path.join(root, 'console.exe'), compile = path.join(root, 'compile.cmd')
  await fs.writeFile(source, String.raw`#include <windows.h>
#include <cstdio>
int main(){DWORD in=0,out=0; auto w=GetConsoleWindow(); printf("{\"window\":%d,\"visible\":%d,\"cp\":%u,\"stdin_console\":%d,\"stdout_console\":%d}\n",w!=nullptr,IsWindowVisible(w),GetConsoleCP(),GetConsoleMode(GetStdHandle(STD_INPUT_HANDLE),&in),GetConsoleMode(GetStdHandle(STD_OUTPUT_HANDLE),&out));}
`)
  await fs.writeFile(compile, `@echo off\r\ncall "${stdout.trim()}\\Common7\\Tools\\VsDevCmd.bat" -arch=x64 >nul\r\ncl.exe /nologo /MT /O2 "${source}" /link User32.lib /OUT:"${probe}"\r\n`)
  await run('cmd.exe', ['/d', '/s', '/c', compile], { cwd: root, windowsHide: true })
  const filtered = cliEnvironment({ mode: 'none' })
  console.log('CRABOT_SLACK_STARTUP_ENV_KEYS ' + JSON.stringify(Object.keys(process.env).filter(key => !(key in filtered)).sort()))
  for (const [environment, env] of [['full', process.env], ['filtered', filtered]]) {
    for (const style of ['normal', 'hidden', 'wrapper']) for (const input of ['ignore', 'pipe']) {
      for (const [tool, executable, args] of [
        ['console', probe, []],
        ['powershell', path.join(system, 'WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output "fixture-output"']],
        ['official-version', official, ['--version', '--skip-update', '--no-color']],
      ]) console.log('CRABOT_SLACK_STARTUP ' + JSON.stringify({ environment, style, input, tool, result: await inspect(executable, args, env, style, input) }))
    }
  }
} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
