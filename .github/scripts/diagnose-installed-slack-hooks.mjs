// One-shot local diagnosis: read installed tools, use a temporary empty CLI config,
// and execute only local hooks. Never login, run, create, install or delete an App.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)
const output = path.resolve(process.argv[3] || 'Slack-local-diagnosis.json')
const report = { platform: process.platform, node: process.versions.node, local_only: true, checks: [] }
const redact = value => String(value).replace(/\b(?:xox[baprs]-|xapp-|xoxe[.-])[A-Za-z0-9.-]+/g, '[REDACTED]')
  .replace(/(https?:\/\/)[^/\s:@]+:[^/@\s]+@/g, '$1[REDACTED]@')
  .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;}]+/gi, '$1[REDACTED]')
  .slice(-24000)
let temporary, job
async function check(name, operation) {
  try { const value = await operation(); report.checks.push({ name, code: value.code ?? 0, output: redact(value.output ?? value.stdout ?? ''), stderr: redact(value.stderr ?? '') }) }
  catch (error) { report.checks.push({ name, code: error.code ?? 'error', error: redact(error.message), output: redact(error.stdout ?? ''), stderr: redact(error.stderr ?? '') }) }
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
  await check('powershell_without_profile_config', () => execute(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', hooks.hooks['get-hooks']], { env, windowsHide: true, cwd: project, timeout: 15000, maxBuffer: 1024 * 1024 }))
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
