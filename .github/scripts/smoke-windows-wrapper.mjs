// Execute the installer extraction macro with the actual shipped archive/plugin.
// No installer host, registration, user data, or business MM is started.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
assert.equal(process.platform, 'win32')
const execute = promisify(execFile), repo = process.cwd()
const require = createRequire(path.join(repo, 'crabot-desktop/package.json'))
const builder = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib/package.json'))
const builderRoot = path.dirname(builder.resolve('app-builder-lib/package.json'))
const { getMakeNsisPath } = builder(path.join(builderRoot, 'out/toolsets/windows.js'))
const { getPath7za } = builder(path.join(builderRoot, 'out/toolsets/7zip.js'))
const nsis = await getMakeNsisPath(), sevenZip = await getPath7za()
const project = path.resolve(process.argv[2]), distribution = path.join(project, 'distribution')
const installers = (await fs.readdir(distribution)).filter(file => file.endsWith('offline-candidate.exe'))
assert.equal(installers.length, 1)
const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-wrapper-'))
const temporary = path.join(process.env.RUNNER_TEMP || tmpdir(), 'a0000001/b0000002/c0000003/d0000004')
await fs.mkdir(temporary, { recursive: true })
const env = { ...process.env, ...nsis.env, TEMP: temporary, TMP: temporary }
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[key]
const run = (file, args, options = {}) => execute(file, args, { env, timeout: 600_000, maxBuffer: 1024 * 1024, ...options })
const quote = value => value.split('$').join('$$').replaceAll('"', '$\\"')
try {
  await run('7z.exe', ['x', path.join(distribution, installers[0]), '-o' + path.join(root, 'wrapper'), '-y'])
  async function find(directory, name) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) { const found = await find(file, name); if (found) return found }
      else if (entry.name.toLowerCase() === name.toLowerCase()) return file
    }
  }
  const archive = await find(path.join(root, 'wrapper'), 'app-64.7z')
  const plugin = await find(path.join(root, 'wrapper'), 'nsis7z.dll')
  assert.ok(archive && plugin)
  const pluginDirectory = path.join(root, 'plugins')
  await fs.mkdir(pluginDirectory)
  await fs.copyFile(plugin, path.join(pluginDirectory, 'nsis7z.dll'))
  const original = await fs.readFile(path.join(builderRoot, 'templates/nsis/include/extractAppPackage.nsh'), 'utf8')
  const macro = path.join(root, 'extract.nsh')
  await fs.writeFile(macro, original.replace('    DetailPrint `Can', '    FileWrite $ProbeLog "copy-error$\\r$\\n"\n    DetailPrint `Can'))
  const source = await fs.readFile('scripts/desktop/windows-offline-installer.nsi', 'utf8')
  const leaf = source.match(/StrCpy \$INSTDIR "\$PLUGINSDIR\\([^"\\]+)"/)?.[1]
  assert.ok(leaf && source.includes(`RMDir /r "$PLUGINSDIR\\${leaf}"`))
  const relative = 'resources/offline/core/.scrapling-runtime-desktop-ci-b21869a0a229da99-8413626c/packages/playwright/driver/package/lib/tools/skills/playwright-component-testing/references/gallery-spec.md'
  const fixture = path.join(root, 'fixture'), contents = 'real-package-path-regression'
  await fs.mkdir(path.dirname(path.join(fixture, relative)), { recursive: true })
  await fs.writeFile(path.join(fixture, relative), contents)
  const small = path.join(root, 'fixture.7z')
  await run(sevenZip, ['a', '-t7z', small, '.'], { cwd: fixture })
  const verify = path.join(root, 'verify.mjs'), verified = path.join(root, 'verified.json')
  await fs.writeFile(verify, `import { promises as fs } from 'node:fs'; import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
try {
const { verifyDesktopPayload } = await import(${JSON.stringify(pathToFileURL(path.join(repo, 'scripts/lib/desktop-payload.mjs')).href)});
const payload = await verifyDesktopPayload(path.join(process.argv[2], 'resources/offline'));
await fs.writeFile(process.argv[3], JSON.stringify({ complete: true, bytes: String(payload.bytes) }));
} catch (error) {
const core = path.join(process.argv[2], 'resources/offline/core');
const expected = JSON.parse(await fs.readFile(path.join(core, 'core-files.json'), 'utf8')).files;
const actual = new Set(), differences = [];
async function walk(directory) { for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
const file = path.join(directory, entry.name), name = path.relative(core, file).split(path.sep).join('/');
if (entry.isDirectory()) await walk(file); else if (!['core-files.json', 'core-release.json', 'desktop-host.json'].includes(name)) actual.add(name);
} }
await walk(core);
for (const name of actual) if (!Object.hasOwn(expected, name)) differences.push({ extra: name });
for (const [name, wanted] of Object.entries(expected)) {
if (!actual.has(name)) { differences.push({ missing: name }); continue; }
const file = path.join(core, name), stat = await fs.lstat(file);
if (stat.size !== wanted.size) differences.push({ name, size: stat.size, expected_size: wanted.size });
}
if (!differences.length) for (const [name, wanted] of Object.entries(expected)) {
const digest = createHash('sha256'); for await (const chunk of createReadStream(path.join(core, name))) digest.update(chunk);
if (digest.digest('hex') !== wanted.sha256) { differences.push({ changed: name }); if (differences.length >= 20) break; }
}
await fs.writeFile(process.argv[3], JSON.stringify({ complete: false, error: error.stack, expected: Object.keys(expected).length, actual: actual.size, differences: differences.slice(0, 20) })); process.exitCode = 1;
}`)
  async function probe(name, selectedLeaf, input, full) {
    const log = path.join(root, name + '.txt'), script = path.join(root, name + '.nsi'), executable = path.join(root, name + '.exe')
    await fs.writeFile(script, `Unicode true
SilentInstall silent
RequestExecutionLevel user
!include "LogicLib.nsh"
!addplugindir "${quote(pluginDirectory)}"
!define PRODUCT_NAME "Crabot Installer"
LangString appCannotBeClosed 1033 "Cannot close installer"
!include "${quote(macro)}"
OutFile "${quote(executable)}"
Var ProbeLog
Section
 InitPluginsDir
 StrCpy $INSTDIR "$PLUGINSDIR\\${selectedLeaf}"
 SetOutPath "$INSTDIR"
 FileOpen $ProbeLog "${quote(log)}" w
 !insertmacro extractUsing7za "${quote(input)}"
 ${full ? `ExecWait '\"$INSTDIR\\resources\\offline\\core\\.product-runtime\\node\\node.exe\" \"${quote(verify)}\" \"$INSTDIR\" \"${quote(verified)}\"' $0\n FileWrite $ProbeLog "verify-exit=$0$\\r$\\n"` : `FileOpen $2 "$INSTDIR\\${relative.replaceAll('/', '\\')}" r\n FileRead $2 $3\n FileClose $2\n FileWrite $ProbeLog "content=$3$\\r$\\n"`}
 FileClose $ProbeLog
SectionEnd
`)
    await run(nsis.path, ['/V2', script])
    await run(executable, [])
    return fs.readFile(log, 'utf8')
  }
  const before = await probe('legacy-path', 'crabot-installer', small, false)
  assert.ok(!before.includes(contents), 'The original long staging path must reproduce the missing file')
  const after = await probe('fixed-path', leaf, small, false)
  assert.ok(after.includes('content=' + contents), 'The shipped private path must retain the long entry')
  assert.ok(!after.includes('copy-error'))
  const complete = await probe('full-package', leaf, archive, true)
  assert.ok(!complete.includes('copy-error'), 'The full package must not enter the Retry branch')
  console.log('CRABOT_WINDOWS_WRAPPER_VERIFY ' + JSON.stringify({ result: complete, verification: await fs.readFile(verified, 'utf8').catch(error => error.message) }))
  if (process.argv.includes('--probe-bcj')) {
    const listing = await run(sevenZip, ['l', '-slt', archive]);
    console.log('CRABOT_WINDOWS_ARCHIVE_METHODS ' + listing.stdout.split(/\r?\n\r?\n/).filter(block => /[tw]64-arm\.exe/.test(block)).join('\n'));
    const unpacked = path.join(root, 'modern-extraction'), repacked = path.join(root, 'compatible.7z');
    await run(sevenZip, ['x', archive, '-o' + unpacked, '-y']);
    const { verifyDesktopPayload } = await import('../../scripts/lib/desktop-payload.mjs');
    await verifyDesktopPayload(path.join(unpacked, 'resources/offline'));
    await run(sevenZip, ['a', '-t7z', '-mx=1', '-mf=BCJ', repacked, '.'], { cwd: unpacked });
    await fs.rm(verified, { force: true });
    const compatible = await probe('compatible-filter', leaf, repacked, true);
    console.log('CRABOT_WINDOWS_COMPATIBLE_FILTER ' + JSON.stringify({ result: compatible, verification: await fs.readFile(verified, 'utf8').catch(error => error.message) }));
    assert.ok(compatible.includes('verify-exit=0'), compatible);
    assert.equal(JSON.parse(await fs.readFile(verified, 'utf8')).complete, true);
  } else {
  assert.ok(complete.includes('verify-exit=0'), complete)
  assert.equal(JSON.parse(await fs.readFile(verified, 'utf8')).complete, true)
  }
  console.log('CRABOT_WINDOWS_WRAPPER ' + JSON.stringify({ old_path_reproduced: true, fixed_long_path: true, full_payload_inventory: true, retry_branch: false, business_mm_started: false }))
} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
