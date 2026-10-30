import fs from 'node:fs/promises'
import path from 'node:path'
export const SLACK_MANIFEST = {
  display_information: { name: 'Crabot', description: 'Crabot local direct connection' },
  features: { bot_user: { display_name: 'Crabot', always_online: false }, app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false } },
  oauth_config: { scopes: { bot: ['chat:write', 'channels:history', 'groups:history', 'channels:read', 'groups:read', 'im:history', 'im:read', 'im:write', 'users:read'] } },
  settings: { event_subscriptions: { bot_events: ['message.channels', 'message.groups', 'message.im'] }, socket_mode_enabled: true, org_deploy_enabled: false, token_rotation_enabled: false },
}
export async function prepareProject(root: string, name = 'Crabot'): Promise<string> {
  const project = path.join(root, 'project')
  await fs.mkdir(path.join(project, '.slack'), { recursive: true, mode: 0o700 })
  // Official CLI uses PowerShell on Windows and sh here on POSIX (no SHELL override).
  // Quote each controlled path as a literal; instance names and challenges never enter hooks.
  for (const value of [process.execPath, project]) if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Slack CLI 工具路径包含不支持的控制字符')
  const quote = (value: string) => process.platform === 'win32'
    ? "'" + value.replaceAll("'", "''") + "'"
    : "'" + value.replaceAll("'", "'\\''") + "'"
  const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(path.join(project, 'hook.mjs'))}`
  const hooks = { runtime: 'node', hooks: { 'get-hooks': `${command} config` }, config: { 'sdk-managed-connection-enabled': true } }
  await fs.writeFile(path.join(project, '.slack', 'hooks.json'), JSON.stringify(hooks), { mode: 0o600, flag: 'wx' })
  const manifest = { ...SLACK_MANIFEST, display_information: { ...SLACK_MANIFEST.display_information, name },
    features: { ...SLACK_MANIFEST.features, bot_user: { ...SLACK_MANIFEST.features.bot_user, display_name: name } } }
  await fs.writeFile(path.join(project, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' })
  await fs.writeFile(path.join(project, 'hook.mjs'), `import fs from 'node:fs';
const mode = process.argv[2];
if (mode === 'config') console.log(JSON.stringify({runtime:'node',hooks:{'get-manifest':${JSON.stringify(`${command} manifest`)},start:${JSON.stringify(`${command} handoff`)}},config:{'sdk-managed-connection-enabled':true}}));
else if (mode === 'manifest') console.log(fs.readFileSync(new URL('./manifest.json',import.meta.url),'utf8'));
else if (mode === 'handoff') {
 const bot_token=process.env.SLACK_BOT_TOKEN||process.env.SLACK_CLI_XOXB;
 const app_token=process.env.SLACK_APP_TOKEN||process.env.SLACK_CLI_XAPP;
 if(!/^xoxb-[A-Za-z0-9-]+$/.test(bot_token||'')||!/^xapp-[A-Za-z0-9-]+$/.test(app_token||'')) process.exit(2);
 fs.writeFileSync(new URL('../handoff.json',import.meta.url),JSON.stringify({bot_token,app_token}),{mode:0o600,flag:'wx'});
 fs.writeFileSync(new URL('../hook-state.json',import.meta.url),JSON.stringify({pid:process.pid}),{mode:0o600,flag:'wx'});
 const timer=setInterval(()=>{if(fs.existsSync(new URL('./stop',import.meta.url)))process.exit(0)},100);
 for(const sig of ['SIGINT','SIGTERM']) process.on(sig,()=>{clearInterval(timer);process.exit(0)});
} else process.exit(2);
`, { mode: 0o600, flag: 'wx' })
  return project
}
