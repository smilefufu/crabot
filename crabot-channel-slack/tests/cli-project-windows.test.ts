import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prepareProject } from '../src/cli-project.js'
import { startCli } from '../dist/cli-tools.js'

const execute = promisify(execFile)
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))) })
const literal = (text: string) => "'" + text.replaceAll("'", "''") + "'"
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "crabot hooks 中文's $safe &-")); roots.push(root)
  const project = await prepareProject(root, 'slack-on-win')
  const hooks = JSON.parse(await fs.readFile(path.join(project, '.slack/hooks.json'), 'utf8'))
  const shell = path.join(process.env.SystemRoot || process.env.SYSTEMROOT!, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const run = (command: string, env = process.env) => execute(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, cwd: project, env, timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8' })
  return { root, project, command: hooks.hooks['get-hooks'] as string, run, shell }
}

it.skipIf(process.platform !== 'win32')('runs generated config and manifest hooks with CLI arguments and special paths', async () => {
  const { project, command, run } = await fixture()
  const config = JSON.parse((await run(command)).stdout)
  const manifest = JSON.parse((await run(config.hooks['get-manifest'] + ' --source=' + literal(project))).stdout)
  expect(manifest.display_information.name).toBe('slack-on-win')
  expect(manifest.features.bot_user.display_name).toBe('slack-on-win')
}, 35000)

it.skipIf(process.platform !== 'win32')('preserves every native argument including quotes, empty strings and trailing slashes', async () => {
  const { project, command, run } = await fixture()
  await fs.writeFile(path.join(project, 'hook.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))')
  const args = ['--source=中文 path', '', 'say "hello"', 'C:\\trailing path\\', '$literal', "a'b", '&']
  expect(JSON.parse((await run(command + ' ' + args.map(literal).join(' '))).stdout)).toEqual(['config', ...args])
}, 20000)

it.skipIf(process.platform !== 'win32')('drains both output pipes and preserves a nonzero child exit code', async () => {
  const { project, command, run } = await fixture()
  await fs.writeFile(path.join(project, 'hook.mjs'), "process.stdout.write('o'.repeat(100000));process.stderr.write('e'.repeat(100000));process.exitCode=7")
  await expect(run(command)).rejects.toMatchObject({ code: 7, stdout: 'o'.repeat(100000), stderr: 'e'.repeat(100000) })
}, 20000)

it.skipIf(process.platform !== 'win32')('runs the generated credential handoff until its existing stop file is written', async () => {
  const { root, project, command, run, shell } = await fixture()
  const config = JSON.parse((await run(command)).stdout)
  const job = startCli(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$env:SLACK_BOT_TOKEN='xoxb-fixture';$env:SLACK_APP_TOKEN='xapp-fixture';" + config.hooks.start], project, { mode: 'none' })
  let pid: number | undefined
  try {
    for (let index = 0; index < 100; index++) {
      try { await fs.access(path.join(root, 'handoff.json')); break } catch { await new Promise(resolve => setTimeout(resolve, 50)) }
    }
    expect(JSON.parse(await fs.readFile(path.join(root, 'handoff.json'), 'utf8'))).toEqual({ bot_token: 'xoxb-fixture', app_token: 'xapp-fixture' })
    pid = JSON.parse(await fs.readFile(path.join(root, 'hook-state.json'), 'utf8')).pid
  } finally { await job.stop() }
  expect(await job.result).toMatchObject({ code: 0 })
  expect(typeof pid).toBe('number')
  expect(() => process.kill(pid!, 0)).toThrow()
}, 25000)
