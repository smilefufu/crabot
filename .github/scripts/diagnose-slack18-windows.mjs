// Diagnostic only. No real Slack credentials, login, installation, or App creation.
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { ensureCli, startCli, privateDirectory } from '../../crabot-channel-slack/dist/cli-tools.js'
import { prepareProject } from '../../crabot-channel-slack/dist/cli-project.js'

assert.equal(process.platform, 'win32')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const root = path.resolve('.desktop-build/slack18-diagnosis')
await fs.mkdir(root, { recursive: true })
const observer = spawn(path.resolve('.desktop-build/observe-slack-windows.exe'), [root], { windowsHide: true, stdio: 'ignore' })
const observerExit = once(observer, 'exit')
const report = []
let job
async function phase(name, operation) {
  await fs.writeFile(path.join(root, 'phase'), name)
  const start = Date.now()
  const value = await operation()
  await sleep(500)
  report.push({ phase: name, elapsed_ms: Date.now() - start, ...value })
}
try {
  for (let index = 0; index < 200; index++) {
    try { await fs.access(path.join(root, 'observer-ready')); break } catch { await sleep(50) }
  }
  await fs.access(path.join(root, 'observer-ready'))
  await phase('positive-visible-cmd', async () => {
    const child = spawn(path.resolve('.desktop-build/observe-slack-windows.exe'), ['--visible-control'], { windowsHide: true, stdio: 'ignore' })
    const [code] = await once(child, 'exit'); return { code, pid: child.pid }
  })
  await phase('negative-hidden-cmd', async () => {
    const child = spawn('cmd.exe', ['/d', '/c', 'ping -n 3 127.0.0.1 >nul'], { windowsHide: true, stdio: 'ignore' })
    const [code] = await once(child, 'exit'); return { code, pid: child.pid }
  })
  let executable
  await phase('private-directory-and-tool-preparation', async () => {
    await privateDirectory(path.join(root, 'data'))
    executable = await ensureCli(path.join(root, 'data'), AbortSignal.timeout(120000))
    return { executable }
  })
  const project = await prepareProject(path.join(root, 'data'), 'slack-on-win')
  await privateDirectory(path.join(root, 'data/cli'))
  for (let index = 0; index < 3; index++) for (const [name, args] of [
    ['official-version', ['--version']],
    ['official-hooks-manifest', ['manifest', 'info', '--source', 'local', '--skip-update', '--no-color', '--config-dir', path.join(root, 'data/cli')]],
  ]) {
    await phase(`${name}-${index}`, async () => {
      job = startCli(executable, args, project, { mode: 'none' })
      let timer
      try {
        const result = await Promise.race([job.result, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Tool stalled')), 30000) })])
        return { code: result.code, output: result.output.slice(-10000) }
      } finally { clearTimeout(timer); await job.stop(); job = undefined }
    })
  }
} finally {
  await job?.stop().catch(() => {})
  await fs.writeFile(path.join(root, 'observer-stop'), '1')
  await Promise.race([observerExit, sleep(3000).then(() => observer.kill())])
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2))
}
const events = (await fs.readFile(path.join(root, 'window-events.tsv'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => {
  const [phase, time, event, pid, parent_pid, hwnd, visible, window_class, image] = line.split('\t')
  return { phase, time: +time, event: +event, pid: +pid, parent_pid: +parent_pid, hwnd, visible: +visible === 1, window_class, image }
})
const shown = events.filter(event => event.event === 0x8002)
const positive = shown.filter(event => event.phase === 'positive-visible-cmd' && /ConsoleWindowClass|CASCADIA/i.test(event.window_class))
const observed = { positive_control: positive.length > 0, shown_windows: shown, all_events: events.length, report }
await fs.writeFile(path.join(root, 'summary.json'), JSON.stringify(observed, null, 2))
console.log(JSON.stringify(observed, null, 2))
assert.ok(observed.positive_control, 'Observer must catch an intentionally visible terminal; absence cannot prove no flashes')
