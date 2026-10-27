// Reproduce the current installer's profile prefix with the real Electron only.
// No Core, installer action, OS entries, model, or existing user profile is used.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
assert.equal(process.env.GITHUB_ACTIONS, 'true')
const electron = process.argv[2], temporary = process.env.RUNNER_TEMP
assert.ok(path.isAbsolute(electron) && temporary && path.isAbsolute(temporary))
const source = (await fs.readFile(new URL('../../crabot-desktop/src/installer-main.ts', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
const prefix = source.match(/async function boot\(\) \{\n([\s\S]+?)\n  await app.whenReady\(\)/)?.[1]
assert.ok(prefix && prefix.includes("app.setPath('sessionData', profile)"))
const results = []
for (const mode of ['current-cjs-import', 'current-esm-entry', 'sync-cjs-import', 'sync-esm-entry']) {
  const root = await fs.mkdtemp(path.join(temporary, 'Crabot 安装初始化 '))
  try {
    const home = path.join(root, 'home'), entry = mode.endsWith('esm-entry') ? 'entry.mjs' : 'entry.cjs'
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local') }
    delete env.ELECTRON_RUN_AS_NODE
    for (const directory of [env.APPDATA, env.LOCALAPPDATA]) await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'crabot-installer-initialization-probe', type: 'module', main: entry }))
    const body = mode.startsWith('sync-') ? prefix.replace('await mkdtemp(', 'mkdtempSync(') : prefix
    await fs.writeFile(path.join(root, 'profile.mjs'), `import { app } from 'electron';
import path from 'node:path'; import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises'; import { mkdtempSync } from 'node:fs';
app.setName('安装 Crabot');
async function boot() { ${body}
console.log('CRABOT_PROFILE_CONFIGURED '+JSON.stringify({ready:app.isReady()}));
await app.whenReady(); console.log('CRABOT_PROFILE_READY'); app.exit(0); }
void boot().catch(error=>{console.error(error.code||error.name);app.exit(2)});
`)
    await fs.writeFile(path.join(root, entry), entry.endsWith('.cjs')
      ? "void import('./profile.mjs');\n" : "import './profile.mjs';\n")
    const result = await new Promise((resolve, reject) => {
      const child = spawn(electron, [root, '--enable-logging=stderr'], { env, timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { if (output.length < 65536) output += bytes })
      child.on('error', reject); child.on('close', (code, signal) => resolve({ mode, code, signal,
        configured_before_ready: output.includes('CRABOT_PROFILE_CONFIGURED {"ready":false}'),
        reached_ready: output.includes('CRABOT_PROFILE_READY'),
        fatal: output.split('\n').filter(line => /FATAL|Check failed|CHECK failed/.test(line)).map(line => line.replaceAll(root, '<fixture>')).slice(0, 4) }))
    })
    results.push(result); console.log('CRABOT_INSTALLER_PROFILE_PROBE ' + JSON.stringify(result))
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}
assert.equal(results.length, 4)
