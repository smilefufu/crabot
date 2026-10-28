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
  const version = execFileSync(executable, ['--version'], { cwd: root, env: cliEnvironment(), timeout: 15000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
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
    for (const [label, stdio] of [['stdin-pipe', ['pipe', 'pipe', 'pipe']], ['overlapped-output', ['ignore', 'overlapped', 'overlapped']]]) {
      try {
        const output = execFileSync(executable, ['--version'], { ...options, stdio })
        console.log(`Slack CLI startup diagnostic: ${label} pinned-version=${output.includes('4.11.0')}`)
      } catch { console.log(`Slack CLI startup diagnostic: ${label} failed`) }
    }
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
      execFile(executable, ['--version'], options, (error, output) => {
        console.log(`Slack CLI startup diagnostic: async-default-pipes pinned-version=${!error && output.includes('4.11.0')}`)
        resolve()
      })
    })
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
