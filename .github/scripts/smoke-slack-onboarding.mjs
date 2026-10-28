import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
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
    // Diagnostic-only profiles: never use their result to accept the original failed probe.
    const base = cliEnvironment()
    const standard = { ...base }
    for (const key of ['OS', 'SystemDrive', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'PATHEXT', 'ProgramData', 'ProgramFiles', 'CommonProgramFiles', 'WINDIR', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) {
      if (process.env[key] !== undefined) standard[key] = process.env[key]
    }
    for (const [label, env] of [['standard-windows-env', standard], ['noninteractive-terminal', { ...base, CI: 'true', TERM: 'dumb', NO_COLOR: '1' }]]) {
      try {
        const output = execFileSync(executable, ['--version'], { cwd: root, env, timeout: 15000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        console.log(`Slack CLI startup diagnostic: ${label} pinned-version=${output.includes('4.11.0')}`)
      } catch { console.log(`Slack CLI startup diagnostic: ${label} failed`) }
    }
    let plain
    try {
      plain = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-cli-startup-'))
      await privateDirectory(plain)
      const copy = path.join(plain, 'slack.exe')
      await fs.copyFile(executable, copy)
      const output = execFileSync(copy, ['--version'], { cwd: plain, env: base, timeout: 15000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      console.log(`Slack CLI startup diagnostic: simple-private-path pinned-version=${output.includes('4.11.0')}`)
    } catch { console.log('Slack CLI startup diagnostic: simple-private-path failed') }
    finally { if (plain) await fs.rm(plain, { recursive: true, force: true }).catch(() => console.log('Slack CLI startup diagnostic: temporary copy cleanup failed')) }
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
