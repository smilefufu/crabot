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
import { createRequire } from 'node:module';import { promises as fs } from 'node:fs';import path from 'node:path';import { promisify } from 'node:util';import { execFile } from 'node:child_process';
const require=createRequire(import.meta.url),start=require('./scripts/lib/module-process-start.cjs'),directory=path.join(process.argv[1],'module-runtime-registry');
for(const name of await fs.readdir(path.join(directory,'records'))){const record=JSON.parse(await fs.readFile(path.join(directory,'records',name),'utf8'));try{console.log('CRABOT_START_PROBE',JSON.stringify({pid:record.root_pid,expected:record.process_start_identity,current:await start.probeProcessStartIdentity(record.root_pid)}))}catch(e){console.error('CRABOT_START_PROBE_ERROR',e)}}
const ps=path.join(process.env.SystemRoot||process.env.WINDIR,'System32/WindowsPowerShell/v1.0/powershell.exe');
try{const result=await promisify(execFile)(ps,['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; ConvertTo-Json -InputObject @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port } | Sort-Object -Unique) -Compress"],{windowsHide:true,timeout:10000});console.log('CRABOT_LISTENERS_PROBE',JSON.stringify(result))}catch(e){console.error('CRABOT_LISTENERS_PROBE_ERROR',e)}
try{const role=await import('./scripts/lib/legacy-module-records.mjs');console.log('CRABOT_STOPPED_RECORDS',JSON.stringify(await role.readStoppedLegacyModuleRecords(process.argv[1])))}catch(e){console.error('CRABOT_STOPPED_RECORDS_ERROR',e);process.exitCode=1}
`
try {
  const result = await execute(path.join(core, '.product-runtime/node/node.exe'), ['--input-type=module', '--eval', script, data], { cwd: core, env, timeout: 60000, maxBuffer: 128000 })
  process.stdout.write(result.stdout); process.stderr.write(result.stderr)
} catch (error) { process.stdout.write(error.stdout || ''); process.stderr.write(error.stderr || ''); throw error }
finally { await fs.rm(home, { recursive: true, force: true }) }
