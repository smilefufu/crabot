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
  const filtered = cliEnvironment({ mode: 'none' })
  const shell = path.join(system, 'WindowsPowerShell/v1.0/powershell.exe')
  const psArgs = ['-NoProfile', '-NonInteractive', '-Command', "Write-Output 'fixture-output'"]
  const groups = {
    windir: ['WINDIR'], modules: ['PSModulePath', 'PSModuleAnalysisCachePath'], systemdrive: ['SYSTEMDRIVE'], executable_suffixes: ['PATHEXT'],
    programfiles: ['PROGRAMFILES', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'COMMONPROGRAMFILES', 'CommonProgramFiles(x86)', 'CommonProgramW6432'],
    user: ['USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'COMPUTERNAME'],
    processor: ['OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'],
    terminal: ['TERM', 'MSYSTEM', 'EXEPATH', 'SHLVL', 'POWERSHELL_DISTRIBUTION_CHANNEL', 'POWERSHELL_UPDATECHECK'],
  }
  let env = { ...filtered }
  for (const keys of Object.values(groups)) for (const key of keys) if (process.env[key] !== undefined) env[key] = process.env[key]
  let result = await inspect(shell, psArgs, env, 'normal', 'ignore')
  console.log('CRABOT_SLACK_ENV_GROUP ' + JSON.stringify({ group: 'all-os', result }))
  if (result.code === 0 && result.output.includes('fixture-output')) for (const [group, keys] of Object.entries(groups)) {
    const candidate = { ...env }
    for (const key of keys) delete candidate[key]
    const result = await inspect(shell, psArgs, candidate, 'normal', 'ignore')
    const unnecessary = result.code === 0 && result.output.includes('fixture-output')
    if (unnecessary) env = candidate
    console.log('CRABOT_SLACK_ENV_GROUP ' + JSON.stringify({ group, removal_succeeded: unnecessary, result }))
  }
  console.log('CRABOT_SLACK_REQUIRED_ENV_KEYS ' + JSON.stringify(Object.keys(env).filter(key => !(key in filtered))))
  const quote = value => "'" + value.replaceAll("'", "''") + "'"
  const enableVT = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class VTProbe { [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string name,uint access,uint share,IntPtr security,uint create,uint flags,IntPtr template); [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h,out uint mode); [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h,uint mode); [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h); public static void Enable(){var h=CreateFileW("CONOUT$",0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero);uint mode;if(!GetConsoleMode(h,out mode)||!SetConsoleMode(h,mode|4))throw new Exception("Cannot enable VT");CloseHandle(h);} }'; [VTProbe]::Enable(); `
  const script = enableVT + `& ${quote(official)} --version --skip-update --no-color`
  console.log('CRABOT_SLACK_VT ' + JSON.stringify({ result: await inspect(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], process.env, 'wrapper', 'ignore') }))

} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
