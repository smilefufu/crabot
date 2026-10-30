// Native, tiny fixture: the actual pinned decoder under ordinary/deep/Unicode TEMP.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
assert.equal(process.platform, 'win32')
const require = createRequire(path.resolve('crabot-desktop/package.json'))
const builder = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib/package.json'))
const rootBuilder = path.dirname(builder.resolve('app-builder-lib/package.json'))
const { getMakeNsisPath, getNsisPluginsPath } = builder(path.join(rootBuilder, 'out/toolsets/windows.js'))
const { getPath7za } = builder(path.join(rootBuilder, 'out/toolsets/7zip.js'))
const nsis = await getMakeNsisPath(), plugins = await getNsisPluginsPath(), seven = await getPath7za()
const execute = promisify(execFile), root = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, 'extract-proof-'))
const quote = value => value.split('$').join('$$').replaceAll('"', '$\\"')
const relative = 'resources/offline/core/.scrapling-runtime-desktop-ci-b21869a0a229da99-8413626c/packages/playwright/driver/package/lib/tools/skills/playwright-component-testing/references/gallery-spec.md'
const value = 'exact archive bytes'
try {
 const candidates = (await fs.readdir(plugins, { recursive: true })).filter(file => /nsis7z\.dll$/i.test(file) && !file.includes('ansi'))
 assert.equal(candidates.length, 1)
 const localPlugins = path.join(root, 'plugins'); await fs.mkdir(localPlugins)
 await fs.copyFile(path.join(plugins, candidates[0]), path.join(localPlugins, 'nsis7z.dll'))
 const fixture = path.join(root, 'input'); await fs.mkdir(path.dirname(path.join(fixture, relative)), { recursive: true })
 await fs.writeFile(path.join(fixture, relative), value)
 const archive = path.join(root, 'input.7z')
 await execute(seven, ['a', '-t7z', '-mf=BCJ', archive, '.'], { cwd: fixture })
 const verify = path.join(root, 'verify.mjs')
 await fs.writeFile(verify, `import assert from 'node:assert/strict';import{promises as fs}from'node:fs';import path from'node:path';assert.equal(await fs.readFile(path.join(process.argv[2],${JSON.stringify(relative)}),'utf8'),${JSON.stringify(value)});await fs.writeFile(process.argv[3],'verified');`)
 const production = await fs.readFile('scripts/desktop/windows-offline-installer.nsi', 'utf8')
 const direct = production.match(/!macro extractUsing7za FILE\r?\n[\s\S]*?!macroend/)?.[0]
 assert.ok(direct)
 const results = []
 for (const [name, temporary] of [ ['ordinary', path.join(root, 'temp')], ['deep', path.join(process.env.RUNNER_TEMP, ...Array.from({length:14},(_,i) => 'depth' + String(i).padStart(3,'0')))], ['unicode', path.join(root, '中文 空格 临时目录')] ]) {
  await fs.mkdir(temporary, { recursive: true })
  const report = path.join(root, name + '.txt'), script = path.join(root, name + '.nsi'), exe = path.join(root, name + '.exe')
  await fs.writeFile(script, `Unicode true\nSilentInstall silent\nRequestExecutionLevel user\n!addplugindir "${quote(localPlugins)}"\n${direct}\nOutFile "${quote(exe)}"\nSection\nInitPluginsDir\nSetOutPath "$PLUGINSDIR\\i"\n!insertmacro extractUsing7za "${quote(archive)}"\nExecWait '"${quote(process.execPath)}" "${quote(verify)}" "$OUTDIR" "${quote(report)}"' $0\nSetErrorLevel $0\nSectionEnd\n`)
  await execute(nsis.path, ['/V2', script], { env: { ...process.env, ...nsis.env }, timeout:120000 })
  await execute(exe, [], { env: { ...process.env, TEMP: temporary, TMP: temporary }, timeout:60000 })
  assert.equal(await fs.readFile(report, 'utf8'), 'verified')
  results.push({ name, temp_length: temporary.length, exact_bytes: true })
 }
 console.log('CRABOT_DIRECT_EXTRACT ' + JSON.stringify(results))
} finally { await fs.rm(root, { recursive: true, force: true, maxRetries:10, retryDelay:100 }) }
