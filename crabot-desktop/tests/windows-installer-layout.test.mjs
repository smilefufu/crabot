import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { packageWindowsInstaller } from '../../scripts/desktop/package-windows-installer.mjs'

test('Windows packaging contains one final program tree and no Electron installer or duplicate runtime payload', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-single-extraction-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const output = path.join(root, 'output'), source = path.join(root, 'source'), directory = path.join(source, 'offline')
  const coreRoot = path.join(directory, 'core'), guiRoot = path.join(directory, 'gui')
  await fs.mkdir(output); await fs.mkdir(path.join(coreRoot, 'bin'), { recursive: true }); await fs.mkdir(guiRoot, { recursive: true })
  await fs.writeFile(path.join(coreRoot, 'bin/crabot.exe'), 'native CLI bytes')
  await fs.writeFile(path.join(coreRoot, 'runtime.bin'), 'one runtime copy')
  await fs.writeFile(path.join(guiRoot, 'Crabot.exe'), 'actual user GUI bytes')
  await fs.writeFile(path.join(coreRoot, 'core-files.json'), JSON.stringify({ schema_version: 1, files: {
    'bin/crabot.exe': { type: 'file', sha256: 'a'.repeat(64) }, 'runtime.bin': { type: 'file', sha256: 'b'.repeat(64) },
  } }))
  for (const name of ['core-release.json', 'desktop-host.json']) await fs.writeFile(path.join(coreRoot, name), '{}')
  const selection = { schema_version: 1, version: '1.2.3', gui_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', core_id: 'b'.repeat(64) }
  const record = { schema_version: 1, platform: 'win32', arch: 'x64', selection, gui: { 'Crabot.exe': { type: 'file', sha256: 'c'.repeat(64) } } }
  await packageWindowsInstaller({ root, output, source, payload: { directory, coreRoot, guiRoot, record }, distribute: false })
  const files = (await fs.readdir(path.join(output, 'programs'), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
  assert.equal(files.length, 8)
  assert.equal(await fs.readFile(path.join(output, 'programs/program/gui/Crabot.exe'), 'utf8'), 'actual user GUI bytes')
  assert.equal(await fs.readFile(path.join(output, 'programs/program/core/runtime.bin'), 'utf8'), 'one runtime copy')
  assert.equal(await fs.readFile(path.join(output, 'programs/bin/crabot.exe'), 'utf8'), 'native CLI bytes')
  const plan = await fs.readFile(path.join(output, 'program-files.tsv'), 'utf8')
  assert.match(plan, /program\/core\/core-files\.json\n/)
  assert.match(plan, /program\/gui\/Crabot\.exe\n/)
  assert.doesNotMatch(plan, /data\//)
  const location = JSON.parse(await fs.readFile(path.join(output, 'installer-location.json'), 'utf8'))
  assert.equal(location.bootstrap, 'windows-first-launch')
  assert.equal(path.resolve(output, location.executable), path.join(output, 'programs/program/gui/Crabot.exe'))
  for (const absent of ['data', 'desktop-installation.json', 'current-release.json', 'resources/offline', 'CrabotInstaller.exe', 'app/releases', 'releases']) {
    await assert.rejects(fs.lstat(path.join(output, 'programs', absent)), { code: 'ENOENT' })
  }
})

test('Windows install section replaces only fixed programs and launches GUI after Finish without data admission', async () => {
  const source = await fs.readFile(new URL('../../scripts/desktop/windows-offline-installer.nsi', import.meta.url), 'utf8')
  const section = source.slice(source.indexOf('Section "安装 Crabot"'), source.indexOf('SectionEnd'))
  assert.match(section, /SetOutPath "\$INSTDIR"/)
  assert.doesNotMatch(section, /ExecWait|--install-root|StrCpy \$INSTDIR|taskkill|Stop-Process|migrate/i)
  const removals = section.split('\n').filter(line => /^\s*RMDir/.test(line))
  assert.equal(removals.length, 0, 'never delete the whole runtime before overlay preparation')
  assert.match(section, /--prepare-overlay/)
  assert.match(source, /-x@\$PLUGINSDIR\\preserved-files\.txt/)
  assert.match(section, /finish-fixed-install\.mjs/)
  assert.match(section, /--check-programs/)
  assert.match(source, /7za\.exe.*-o\$INSTDIR/)
  assert.match(source, /Function OpenCrabot[\s\S]*Exec '/)
  assert.doesNotMatch(source, /Nsis7z::Extract|APP_64_UNPACKED_SIZE\} \* 1024/)
})
