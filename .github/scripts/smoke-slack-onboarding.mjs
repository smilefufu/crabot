import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureCli, privateDirectory, startCli } from '../../crabot-channel-slack/dist/cli-tools.js'
import { prepareProject, SLACK_MANIFEST } from '../../crabot-channel-slack/dist/cli-project.js'
const root = await fs.mkdtemp(path.join(os.tmpdir(), "crabot slack-cli's $safe-"))
const originalFetch = globalThis.fetch
let job, commandTimer
try {
  console.log(`Slack CLI smoke: preparing private tool directory (${process.platform}/${process.arch})`)
  await privateDirectory(root)
  if (process.env.SLACK_CLI_TEST_ARCHIVE) globalThis.fetch = async () => new Response(await fs.readFile(process.env.SLACK_CLI_TEST_ARCHIVE))
  let executable
  try { executable = await ensureCli(root, AbortSignal.timeout(300000)) }
  finally { globalThis.fetch = originalFetch }
  console.log('Slack CLI smoke: verified official tool; preparing fixed hooks')
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
} finally {
  clearTimeout(commandTimer)
  globalThis.fetch = originalFetch
  await job?.stop().catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
}
