import { expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SlackOnboarder } from '../src/onboard.js'
import { startCli } from '../dist/cli-tools.js'

it('completes code submission and native project hooks through real supervised processes', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "crabot onboarding's native-"))
  const fixture = path.join(dataDir, 'fixture.cjs')
  // Simulate only the remote CLI responses; the supervisor, PowerShell/sh,
  // generated project hooks, credential handoff and stop/join are real.
  await fs.writeFile(fixture, `
const fs=require('node:fs'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const args=process.argv.slice(2),project=process.cwd();
if(args[0]==='auth') {
 if(args.includes('--challenge')) {
  if(args[args.indexOf('--challenge')+1]!=='fixture-code')process.exit(2);
  fs.writeFileSync(path.join(args[args.indexOf('--config-dir')+1],'credentials.json'),JSON.stringify({TTEST:{team_id:'TTEST',user_id:'UTEST'}}));
 } else console.log('/slackauthticket fixture-ticket');
} else if(args[0]==='run') {
 const shell=process.platform==='win32'?'powershell':'sh';
 const command=value=>process.platform==='win32'?['-Command',value]:['-c',value];
 const hooks=JSON.parse(fs.readFileSync(path.join(project,'.slack/hooks.json'),'utf8'));
 const config=JSON.parse(execFileSync(shell,command(hooks.hooks['get-hooks']),{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 const manifest=JSON.parse(execFileSync(shell,command(config.hooks['get-manifest']),{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 if(manifest.display_information.name!=='Slack-native-fixture'||manifest.features.bot_user.display_name!=='Slack-native-fixture')process.exit(3);
 fs.writeFileSync(path.join(project,'.slack/apps.dev.json'),JSON.stringify({TTEST:{app_id:'ATEST'}}));
 const child=spawn(shell,command(config.hooks.start),{env:{...process.env,SLACK_BOT_TOKEN:'xoxb-fixture',SLACK_APP_TOKEN:'xapp-fixture'},stdio:'inherit'});
 child.on('error',()=>process.exit(4));child.on('exit',code=>process.exit(code??1));
} else process.exit(5);
`)
  const outputs: Array<{ code: number | null; output: string }> = []
  const verify = vi.fn(async () => 'Fixture user')
  const onboarder = new SlackOnboarder({
    dataDir, ensureCli: async () => process.execPath, configureMs: 45000, verify,
    startCli: (_executable, args, cwd, proxy) => {
      const job = startCli(process.execPath, [fixture, ...args], cwd, proxy)
      void job.result.then(result => { outputs.push(result) }).catch(() => {})
      return job
    },
  })
  try {
    const begin = await onboarder.begin({ instance_name: 'Slack-native-fixture', __admin_proxy: { mode: 'custom', custom_url: 'http://127.0.0.1:17890' } })
    expect(begin.authorization_command).toBe('/slackauthticket fixture-ticket')
    await onboarder.submit(begin.session_id, { challenge_code: 'fixture-code' })
    let terminal
    for await (const event of onboarder.poll(begin.session_id)) {
      if (event.type !== 'pending') { terminal = event; break }
    }
    expect(terminal, JSON.stringify(outputs)).toEqual({ type: 'success' })
    expect(verify).toHaveBeenCalledWith(
      { bot_token: 'xoxb-fixture', app_token: 'xapp-fixture' },
      { team_id: 'TTEST', user_id: 'UTEST' }, 'ATEST', expect.any(AbortSignal),
    )
    const result = await onboarder.finish(begin.session_id, { created_instance_id: 'slack-native-fixture' })
    expect(result.authorized_identity).toEqual({ platform_user_id: 'UTEST', platform_display_name: 'Fixture user' })
    const root = path.join(dataDir, 'slack-onboarding', begin.session_id)
    for (const entry of ['project', 'cli', 'handoff.json', 'hook-state.json']) await expect(fs.access(path.join(root, entry))).rejects.toThrow()
  } finally {
    await onboarder.dispose()
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 90000)
