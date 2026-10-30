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
import path from 'node:path';import { promisify } from 'node:util';import { execFile } from 'node:child_process';
const source=JSON.parse(process.argv[1]),base=JSON.parse(process.argv[2]),ps=path.join(base.SystemRoot||base.WINDIR,'System32/WindowsPowerShell/v1.0/powershell.exe');
const names=['PSModulePath','SystemDrive','ProgramFiles','ProgramFiles(x86)','ProgramW6432','ProgramData'];
const get=name=>Object.entries(source).find(([key])=>key.toLowerCase()===name.toLowerCase());
const select=names=>Object.fromEntries(names.map(get).filter(Boolean));
const modes={filtered:base,modules:{...base,...select(['PSModulePath'])},system:{...base,...select(names.slice(1))},all:source};
const script="$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = 2147483647'; ConvertTo-Json -InputObject @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port } | Sort-Object -Unique) -Compress";
const results=await Promise.all(Object.entries(modes).map(async([mode,env])=>{const started=Date.now();console.log('CRABOT_QUERY_BEGIN',mode);try{const result=await promisify(execFile)(ps,['-NoProfile','-NonInteractive','-Command',script],{env,windowsHide:true,timeout:20000,maxBuffer:128000});const record={mode,elapsed_ms:Date.now()-started,success:true,...result};console.log('CRABOT_QUERY_RESULT',JSON.stringify(record));return record}catch(e){const record={mode,elapsed_ms:Date.now()-started,success:false,code:e.code,killed:e.killed,signal:e.signal,stdout:e.stdout,stderr:e.stderr};console.log('CRABOT_QUERY_RESULT',JSON.stringify(record));return record}}));
if(results.some(result=>!result.success))process.exitCode=1;
`
try {
  const result = await execute(path.join(core, '.product-runtime/node/node.exe'), ['--input-type=module', '--eval', script, JSON.stringify(parent), JSON.stringify(env)], { cwd: core, env, timeout: 45000, maxBuffer: 128000 })
  process.stdout.write(result.stdout); process.stderr.write(result.stderr)
} catch (error) { process.stdout.write(error.stdout || ''); process.stderr.write(error.stderr || ''); throw error }
finally { await fs.rm(home, { recursive: true, force: true }) }
