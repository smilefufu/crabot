// Finite read-only reproduction using the actual candidate Node and exactly the
// installer handoff environment. Synthetic records come from exited processes.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stoppedLegacyModules } from '../../scripts/lib/__tests__/fixtures/stopped-legacy-modules.mjs'
assert.equal(process.platform, 'win32'); assert.equal(process.env.GITHUB_ACTIONS, 'true')
const execute = promisify(execFile), core = path.resolve('.desktop-build/manual/paired/offline/core')
const home = await fs.mkdtemp(path.join(tmpdir(), 'Crabot stopped probe ')), data = path.join(home, 'data')
await fs.mkdir(data); await fs.mkdir(path.join(home, 'Roaming')); await fs.mkdir(path.join(home, 'Local'))
await stoppedLegacyModules(data)
const parent = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local'), PATH: path.join(process.env.SystemRoot, 'System32') }
const env = Object.fromEntries(Object.entries(parent).filter(([name]) => /^(PATH|HOME|USER|LOGNAME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_.*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i.test(name)))
const script = `
import { readFile } from 'node:fs/promises';import path from 'node:path';import { promisify } from 'node:util';import { execFile } from 'node:child_process';
const {source,base}=JSON.parse(await readFile(process.argv[1],'utf8')),ps=path.join(base.SystemRoot||base.WINDIR,'System32/WindowsPowerShell/v1.0/powershell.exe');
const known=new Set(Object.keys(base).map(key=>key.toLowerCase()));
const missing=Object.entries(source).filter(([key])=>!known.has(key.toLowerCase()));
const command="$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = 2147483647'; ConvertTo-Json -InputObject @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port } | Sort-Object -Unique) -Compress";
let attempt=0;
async function works(entries){const started=Date.now();try{await promisify(execFile)(ps,['-NoProfile','-NonInteractive','-Command',command],{env:{...base,...Object.fromEntries(entries)},windowsHide:true,timeout:5000,maxBuffer:128000});console.log('CRABOT_ENV_ATTEMPT',JSON.stringify({attempt:++attempt,keys:entries.map(([key])=>key),elapsed_ms:Date.now()-started,success:true}));return true}catch(e){console.log('CRABOT_ENV_ATTEMPT',JSON.stringify({attempt:++attempt,keys:entries.map(([key])=>key),elapsed_ms:Date.now()-started,success:false,killed:e.killed}));return false}}
if(!await works(missing))throw new Error('Full environment control did not pass');
let candidates=missing,n=2;
while(candidates.length>=2){let reduced=false;const size=Math.ceil(candidates.length/n);for(let i=0;i<candidates.length;i+=size){const subset=candidates.filter((_,index)=>index<i||index>=i+size);if(await works(subset)){candidates=subset;n=Math.max(2,n-1);reduced=true;break}}if(!reduced){if(n>=candidates.length)break;n=Math.min(candidates.length,n*2)}}
console.log('CRABOT_REQUIRED_ENVIRONMENT_KEYS',JSON.stringify(candidates.map(([key])=>key)));
if(!await works(candidates))throw new Error('Minimal environment control did not pass');

`
const input = path.join(home, 'environment.json'); await fs.writeFile(input, JSON.stringify({source:parent,base:env}), {mode:0o600})
try {
  const result = await execute(path.join(core, '.product-runtime/node/node.exe'), ['--input-type=module', '--eval', script, input], { cwd: core, env, timeout: 240000, maxBuffer: 128000 })
  process.stdout.write(result.stdout); process.stderr.write(result.stderr)
} catch (error) { process.stdout.write(error.stdout || ''); process.stderr.write(error.stderr || ''); throw new Error('Bounded target environment query failed') }
finally { await fs.rm(home, { recursive: true, force: true }) }
