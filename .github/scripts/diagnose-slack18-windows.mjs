// Diagnostic only. No real Slack credentials, login, installation, or App creation.
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { ensureCli, startCli, privateDirectory } from '../../crabot-channel-slack/dist/cli-tools.js'
import { prepareProject } from '../../crabot-channel-slack/dist/cli-project.js'
import { SlackOnboarder } from '../../crabot-channel-slack/dist/onboard.js'

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
  // Paired diagnostic experiment only: replace generated fixture hooks, never product sources.
  const literal = text => "'" + text.replaceAll("'", "''") + "'"
  const noWindow = (file, mode) => `& { $s=New-Object System.Diagnostics.ProcessStartInfo;$s.FileName=${literal(process.execPath)};$s.Arguments=${literal('"' + file + '" ' + mode)};$s.UseShellExecute=$false;$s.CreateNoWindow=$true;$s.RedirectStandardOutput=$true;$s.RedirectStandardError=$true;$p=[System.Diagnostics.Process]::Start($s);$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync();$p.WaitForExit();[Console]::Out.Write($o.Result);[Console]::Error.Write($e.Result);exit $p.ExitCode }`
  const wrappedConfig = path.join(project, 'diagnostic-get-hooks.cjs')
  await fs.writeFile(wrappedConfig, 'console.log(' + JSON.stringify(JSON.stringify({runtime:'node',hooks:{'get-manifest':noWindow(path.join(project,'hook.mjs'),'manifest')},config:{'sdk-managed-connection-enabled':true}})) + ')')
  await fs.writeFile(path.join(project,'.slack/hooks.json'),JSON.stringify({runtime:'node',hooks:{'get-hooks':noWindow(wrappedConfig,'')},config:{'sdk-managed-connection-enabled':true}}))
  for (let index=0; index<3; index++) await phase(`fixture-inner-node-no-window-${index}`,async()=>{
    job=startCli(executable,['manifest','info','--source','local','--skip-update','--no-color','--config-dir',path.join(root,'data/cli')],project,{mode:'none'})
    let timer
    try {
      const result=await Promise.race([job.result,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture hook stalled')),30000)})])
      return {code:result.code,output:result.output.slice(-10000)}
    }finally{clearTimeout(timer);await job.stop();job=undefined}
  })
  await phase('official-onboarding-local-api-fixture', async () => {
    const requests = [], commands = []
    const server = http.createServer((request, response) => {
      const method = request.url.split('?')[0].split('/').pop()
      requests.push(method)
      request.resume()
      const identity = { team_id: 'TTEST', user_id: 'UTEST', team: 'fixture', team_name: 'fixture', team_domain: 'fixture', user: 'fixture', url: 'https://fixture.slack.com' }
      const result = method === 'apps.hosted.generateAuthTicket' ? { ok: true, ticket: 'fixture-ticket' }
        : method === 'apps.hosted.exchangeAuthTicket' ? { ok: true, is_ready: true, token: 'xoxp-diagnostic-fixture', ...identity }
        : method === 'auth.test' ? { ok: true, ...identity }
        : method === 'apps.manifest.validate' ? { ok: true }
        : { ok: false, error: 'diagnostic_probe_stop', description: 'Local diagnostic fixture only; no real Slack request.' }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const base = `http://127.0.0.1:${server.address().port}`
    const onboarder = new SlackOnboarder({ dataDir: path.join(root, 'synthetic-onboarding'), ensureCli: async () => executable, configureMs: 60000,
      startCli: (file, args, cwd) => {
        const child = startCli(file, [...args, '--apihost', base], cwd, { mode: 'none' })
        void child.result.then(result => commands.push({ command: args[0], code: result.code, output: result.output.slice(-10000) }), error => commands.push({ command: args[0], failure: String(error) }))
        return child
      }, verify: async () => { throw new Error('Fixture must stop before verification') },
    })
    try {
      const begin = await onboarder.begin({ instance_name: 'slack-on-win', __admin_proxy: { mode: 'none' } })
      await onboarder.submit(begin.session_id, { challenge_code: 'synthetic-challenge' })
      let terminal
      for await (const event of onboarder.poll(begin.session_id)) if (event.type !== 'pending') { terminal = event; break }
      return { requests, commands, terminal, real_slack_contacted: false }
    } catch (error) { return { requests, commands, failure: String(error), real_slack_contacted: false } }
    finally { await onboarder.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  })
} finally {
  await job?.stop().catch(() => {})
  await fs.writeFile(path.join(root, 'observer-stop'), '1')
  await Promise.race([observerExit, sleep(3000).then(() => observer.kill())])
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2))
}
const events = (await fs.readFile(path.join(root, 'window-events.tsv'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => {
  const [phase, time, event, pid, parent_pid, hwnd, visible, window_class, image, parent_image] = line.split('\t')
  return { phase, time: +time, event: +event, pid: +pid, parent_pid: +parent_pid, hwnd, visible: +visible === 1, window_class, image, parent_image }
})
const shown = events.filter(event => event.event === 0x8002)
const positive = shown.filter(event => event.phase === 'positive-visible-cmd' && /ConsoleWindowClass|CASCADIA/i.test(event.window_class))
const observed = { positive_control: positive.length > 0, shown_windows: shown, all_events: events.length, report }
await fs.writeFile(path.join(root, 'summary.json'), JSON.stringify(observed, null, 2))
console.log(JSON.stringify(observed, null, 2))
assert.ok(observed.positive_control, 'Observer must catch an intentionally visible terminal; absence cannot prove no flashes')
