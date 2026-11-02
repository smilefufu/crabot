// One-shot local diagnosis: read installed tools, use a temporary empty CLI config,
// and execute only local hooks. Never login, run, create, install or delete an App.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { validateCheck } from './slack-diagnostic-checks.mjs'
const execute = promisify(execFile)
const output = path.resolve(process.argv[3] || 'Slack-local-diagnosis.json')
const report = { platform: process.platform, node: process.versions.node, local_only: true, checks: [] }
const redact = value => String(value).replace(/\b(?:xox[baprs]-|xapp-|xoxe[.-])[A-Za-z0-9.-]+/g, '[REDACTED]')
  .replace(/(https?:\/\/)[^/\s:@]+:[^/@\s]+@/g, '$1[REDACTED]@')
  .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;}]+/gi, '$1[REDACTED]')
  .slice(-24000)
let temporary, job
async function check(name, operation) {
  try {
    const value = await operation()
    const result = { name, code: value.code ?? 0, output: redact(value.output ?? value.stdout ?? ''), stderr: redact(value.stderr ?? '') }
    try { validateCheck(name, value); result.passed = true }
    catch (error) { result.passed = false; result.error = redact(error.message) }
    report.checks.push(result)
  } catch (error) { report.checks.push({ name, passed: false, code: error.code ?? 'error', error: redact(error.message), output: redact(error.stdout ?? ''), stderr: redact(error.stderr ?? '') }) }
}
try {
  if (process.platform !== 'win32') throw new Error('Windows only')
  const install = path.resolve(process.argv[2] || '')
  const record = JSON.parse(await fs.readFile(path.join(install, 'desktop-installation.json'), 'utf8'))
  if (record.paths?.core !== 'program/core') throw new Error('Expected the fixed desktop18 installation layout')
  const core = path.join(install, record.paths.core)
  const data = record.data_dir ?? path.join(install, 'data')
  const tools = await import(pathToFileURL(path.join(core, 'crabot-channel-slack/dist/cli-tools.js')).href)
  const { prepareProject } = await import(pathToFileURL(path.join(core, 'crabot-channel-slack/dist/cli-project.js')).href)
  const tool = path.join(data, 'tools/slack-cli', tools.CLI_VERSION, 'win32-x64')
  const executable = path.join(tool, 'bin/slack.exe')
  const actual = createHash('sha256').update(await fs.readFile(executable)).digest('hex')
  if (actual !== (await fs.readFile(path.join(tool, 'binary.sha256'), 'utf8')).trim()) throw new Error('Existing Slack CLI digest does not match its receipt; diagnostic refused to execute it')
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-local-diagnosis-'))
  await tools.privateDirectory(temporary)
  await tools.privateDirectory(path.join(temporary, 'cli'))
  const project = await prepareProject(temporary, 'slack-on-win')
  const hooks = JSON.parse(await fs.readFile(path.join(project, '.slack/hooks.json'), 'utf8'))
  const env = tools.cliEnvironment({ mode: 'none' })
  await check('direct_node_config', () => execute(process.execPath, [path.join(project, 'hook.mjs'), 'config'], { env, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }))
  await check('direct_node_manifest', () => execute(process.execPath, [path.join(project, 'hook.mjs'), 'manifest'], { env, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }))
  const shell = path.join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const runShell = command => execute(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { env, windowsHide: true, cwd: project, timeout: 15000, maxBuffer: 1024 * 1024 })
  await check('powershell_basic_execution', () => execute(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "[Console]::Out.Write('POWERSHELL_EXECUTED')"], { env, windowsHide: true, cwd: project, timeout: 15000 }))
  await check('powershell_without_profile_config', () => runShell(hooks.hooks['get-hooks']))
  await check('powershell_encoded_config', () => execute(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(hooks.hooks['get-hooks'], 'utf16le').toString('base64')], { env, windowsHide: true, cwd: project, timeout: 15000, maxBuffer: 1024 * 1024 }))
  const configCheck = report.checks.find(item => item.name === 'direct_node_config')
  async function syntheticStart(command) {
    for (const name of ['handoff.json', 'hook-state.json']) await fs.rm(path.join(temporary, name), { force: true })
    job = tools.startCli(shell, ['-Command', "$env:SLACK_BOT_TOKEN='xoxb-diagnostic-fixture';$env:SLACK_APP_TOKEN='xapp-diagnostic-fixture';" + command], project, { mode: 'none' })
    let exited = false, handoff = false
    void job.result.finally(() => { exited = true }).catch(() => {})
    try {
      for (let index = 0; index < 300; index++) {
        try { await fs.access(path.join(temporary, 'handoff.json')); handoff = true; break } catch { /* only this temporary fake credential handoff */ }
        if (exited) return await job.result // check() requires a real handoff, even on exit 0.
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (!handoff) throw new Error('Synthetic local start did not return its handoff within 15 seconds')
      const credentials = JSON.parse(await fs.readFile(path.join(temporary, 'handoff.json'), 'utf8'))
      if (credentials.bot_token !== 'xoxb-diagnostic-fixture' || credentials.app_token !== 'xapp-diagnostic-fixture') throw new Error('Unexpected synthetic credential handoff')
      await job.stop()
      const value = await job.result
      return { ...value, output: value.output + '\nSYNTHETIC_HANDOFF_OK' }
    } finally { await job.stop(); job = undefined }
  }
  if (configCheck?.passed) await check('powershell_start_with_synthetic_credentials', () => syntheticStart(JSON.parse(configCheck.output).hooks.start))
  // Compare the already implemented windowless launch locally, without changing
  // the installed project or invoking Slack's remote APIs.
  const literal = text => "'" + text.replaceAll("'", "''") + "'"
  const windowless = mode => `& { $s=New-Object System.Diagnostics.ProcessStartInfo;$s.FileName=${literal(process.execPath)};$s.Arguments=${literal('"' + path.join(project, 'hook.mjs') + '" ' + mode)};$s.UseShellExecute=$false;$s.CreateNoWindow=$true;$s.RedirectStandardOutput=$true;$s.RedirectStandardError=$true;$p=[System.Diagnostics.Process]::Start($s);try{$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync();$p.WaitForExit();[Console]::Out.Write($o.Result);[Console]::Error.Write($e.Result);$c=$p.ExitCode}finally{$p.Dispose()};exit $c }`
  await check('powershell_windowless_config', () => runShell(windowless('config')))
  await check('powershell_windowless_start_with_synthetic_credentials', () => syntheticStart(windowless('handoff')))
  // Prevent the official CLI from passing through its manifest.json fallback.
  // Only the generated hook knows this diagnostic-only filename.
  await fs.rename(path.join(project, 'manifest.json'), path.join(project, 'diagnostic-manifest.json'))
  const hookFile = path.join(project, 'hook.mjs')
  await fs.writeFile(hookFile, (await fs.readFile(hookFile, 'utf8')).replace("'./manifest.json'", "'./diagnostic-manifest.json'"))
  await check('official_cli_local_manifest', async () => {
    job = tools.startCli(executable, ['manifest', 'info', '--source', 'local', '--skip-update', '--no-color', '--config-dir', path.join(temporary, 'cli')], project, { mode: 'none' })
    let timer
    try { return await Promise.race([job.result, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Local manifest probe exceeded 30 seconds')), 30000) })]) }
    finally { clearTimeout(timer); await job.stop(); job = undefined }
  })
} catch (error) { report.preparation_error = redact(error.message) }
finally {
  await job?.stop().catch(error => { report.cleanup_error = redact(error.message) })
  if (temporary) await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(error => { report.cleanup_error = redact(error.message) })
  await fs.writeFile(output, JSON.stringify(report, null, 2))
  console.log('Local diagnostic report: ' + output)
  if (report.preparation_error) console.error(report.preparation_error)
}
