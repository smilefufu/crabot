import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { cliEnvironment, ensureCli, privateDirectory, startCli } from '../../crabot-channel-slack/dist/cli-tools.js'
import { prepareProject, SLACK_MANIFEST } from '../../crabot-channel-slack/dist/cli-project.js'
const root = await fs.mkdtemp(path.join(os.tmpdir(), "crabot slack-cli's $safe-"))
const originalFetch = globalThis.fetch
let job, commandTimer, executable
try {
  console.log(`Slack CLI smoke: preparing private tool directory (${process.platform}/${process.arch})`)
  await privateDirectory(root)
  if (process.env.SLACK_CLI_TEST_ARCHIVE) globalThis.fetch = async () => new Response(await fs.readFile(process.env.SLACK_CLI_TEST_ARCHIVE))
  try { executable = await ensureCli(root, AbortSignal.timeout(300000)) }
  finally { globalThis.fetch = originalFetch }
  console.log('Slack CLI smoke: checking verified executable startup (15 second limit)')
  const startupEnvironment = cliEnvironment()
  if (process.platform === 'win32') startupEnvironment.GODEBUG = 'inittrace=1'
  let version
  try {
    version = execFileSync(executable, ['--version'], { cwd: root, env: startupEnvironment, timeout: 15000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    // Only package names from Go's initialization trace; no login or CLI output.
    if (process.platform === 'win32') {
      const initialized = String(error.stderr ?? '').split('\n').flatMap(line => {
        const match = /^init ([A-Za-z0-9_./-]+) @/.exec(line)
        return match ? [match[1]] : []
      })
      console.log(`Slack CLI initialization diagnostic: ${initialized.slice(-16).join(', ') || 'no completed package initialization'}`)
    }
    throw error
  }
  assert.ok(version.includes('4.11.0'), 'Verified official executable must report its pinned version')
  console.log('Slack CLI smoke: verified official tool started; preparing fixed hooks')
  const project = await prepareProject(root)
  await privateDirectory(path.join(root, 'cli'))
  console.log('Slack CLI smoke: starting local manifest/hooks command (5 minute limit)')
  job = startCli(executable, ['manifest', 'info', '--source', 'local', '--skip-update', '--no-color', '--config-dir', path.join(root, 'cli')], project)
  const result = await Promise.race([job.result, new Promise((_, reject) => {
    commandTimer = setTimeout(() => reject(new Error('Slack CLI local manifest/hooks command exceeded 5 minutes')), 300000)
  })])
  clearTimeout(commandTimer)
  console.log('Slack CLI smoke: local command exited; validating manifest')
  assert.equal(result.code, 0, 'Official CLI must execute get-hooks and get-manifest on this native platform')
  const first = result.output.indexOf('{'), last = result.output.lastIndexOf('}')
  const manifest = JSON.parse(result.output.slice(first, last + 1))
  assert.deepEqual(manifest.oauth_config.scopes.bot, SLACK_MANIFEST.oauth_config.scopes.bot)
  assert.deepEqual(manifest.settings.event_subscriptions.bot_events, SLACK_MANIFEST.settings.event_subscriptions.bot_events)
  assert.equal(manifest.settings.socket_mode_enabled, true)
  await assert.rejects(fs.access(path.join(root, 'handoff.json')))
  console.log(`Slack CLI 4.11.0 verified archive and real local hooks passed: ${process.platform}/${process.arch}; no login, App creation or messages`)
} catch (error) {
  if (process.platform === 'win32' && executable && !job) {
    // Diagnostic-only I/O profiles; the original failed probe still fails this job.
    const options = { cwd: root, env: cliEnvironment(), timeout: 15000, windowsHide: true, encoding: 'utf8' }
    const handles = []
    try {
      handles.push(await fs.open(path.join(root, 'version.stdout'), 'wx', 0o600))
      handles.push(await fs.open(path.join(root, 'version.stderr'), 'wx', 0o600))
      execFileSync(executable, ['--version'], { ...options, stdio: ['ignore', handles[0].fd, handles[1].fd] })
      const output = await fs.readFile(path.join(root, 'version.stdout'), 'utf8')
      console.log(`Slack CLI startup diagnostic: regular-output-files pinned-version=${output.includes('4.11.0')}`)
    } catch { console.log('Slack CLI startup diagnostic: regular-output-files failed') }
    finally { await Promise.all(handles.map(handle => handle.close().catch(() => {}))) }
    await new Promise(resolve => {
      execFile(executable, ['--version'], { ...options, windowsHide: false }, (error, output) => {
        console.log(`Slack CLI startup diagnostic: node-pipes-console-allowed pinned-version=${!error && output.includes('4.11.0')}`)
        resolve()
      })
    })
    // Compare Windows' standard redirected pipes and console creation independently.
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    for (const noWindow of [true, false]) {
      const script = `
$ErrorActionPreference = 'Stop'
$p = New-Object System.Diagnostics.Process
try {
  $p.StartInfo.FileName = $env:CRABOT_DIAGNOSTIC_EXECUTABLE
  $p.StartInfo.Arguments = '--version'
  $p.StartInfo.UseShellExecute = $false
  $p.StartInfo.CreateNoWindow = $${noWindow}
  $p.StartInfo.WindowStyle = 'Hidden'
  $p.StartInfo.RedirectStandardInput = $true
  $p.StartInfo.RedirectStandardOutput = $true
  $p.StartInfo.RedirectStandardError = $true
  [void]$p.Start()
  $p.StandardInput.Close()
  $stdout = $p.StandardOutput.ReadToEndAsync()
  $stderr = $p.StandardError.ReadToEndAsync()
  $finished = $p.WaitForExit(10000)
  $valid = $finished -and $p.ExitCode -eq 0 -and $stdout.Wait(1000) -and $stdout.Result.Contains('4.11.0')
  [Console]::WriteLine('pinned-version=' + $valid.ToString().ToLowerInvariant())
} catch { [Console]::WriteLine('diagnostic-failed') }
finally {
  if ($p.Id -and -not $p.HasExited) { $p.Kill(); [void]$p.WaitForExit(2000) }
  $p.Dispose()
}`
      await new Promise(resolve => {
        execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { ...options, timeout: 20000, env: { ...options.env, CRABOT_DIAGNOSTIC_EXECUTABLE: executable } }, (error, output) => {
          console.log(`Slack CLI startup diagnostic: dotnet-pipes-create-no-window=${noWindow} pinned-version=${!error && output.trim() === 'pinned-version=true'}`)
          resolve()
        })
      })
    }
  }
  // This isolated manifest-only probe never logs in; report fixed milestones, not raw CLI logs.
  try {
    const state = await fs.access(path.join(root, 'project', 'process-state.json')).then(() => true, () => false)
    console.log(`Slack CLI smoke diagnostic: supervisor recorded CLI spawn=${state}`)
    const logs = path.join(root, 'cli', 'logs')
    for (const name of (await fs.readdir(logs)).filter(name => /^slack-debug-[0-9]+\.log$/.test(name)).slice(0, 4)) {
      const lines = (await fs.readFile(path.join(logs, name), 'utf8')).slice(-65536).split('\n')
      for (const line of lines) {
        for (const marker of ['starting hook command', 'finished hook command', 'initialized SDK CLI config']) {
          if (line.includes(marker)) console.log(`Slack CLI smoke diagnostic: ${marker}`)
        }
      }
    }
  } catch { console.log('Slack CLI smoke diagnostic: isolated CLI log unavailable') }
  throw error
} finally {
  clearTimeout(commandTimer)
  globalThis.fetch = originalFetch
  await job?.stop().catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
}
