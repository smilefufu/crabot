import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'

const helper = process.env.CRABOT_TEST_INSTALL_DIRECTORY
const git = process.env.CRABOT_TEST_GIT_ROOT
const decoder = process.env.CRABOT_TEST_7ZA
const windows = process.platform === 'win32' && helper && git && decoder
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-overlay-'))
  const installed = path.join(root, 'installed'), incoming = path.join(root, 'incoming')
  const runtime = 'program/core/.product-runtime/git/usr/bin'
  for (const directory of [installed, incoming]) {
    await fs.mkdir(path.join(directory, runtime), { recursive: true })
    await fs.mkdir(path.join(directory, 'program/gui'), { recursive: true })
    await fs.writeFile(path.join(directory, 'program/gui/Crabot.exe'), directory === installed ? 'old GUI' : 'new GUI')
    await fs.writeFile(path.join(directory, 'program/core/app.js'), directory === installed ? 'old core' : 'new core')
    for (const name of ['tail.exe', 'msys-2.0.dll', 'msys-iconv-2.dll', 'msys-intl-8.dll']) {
      await fs.copyFile(path.join(git, 'usr/bin', name), path.join(directory, runtime, name))
    }
    await fs.writeFile(path.join(directory, runtime, 'runtime-version.txt'), 'same Git')
  }
  await fs.mkdir(path.join(installed, 'data'))
  await fs.writeFile(path.join(installed, 'data/keep.txt'), 'user data')
  await fs.writeFile(path.join(installed, 'program/core/obsolete.js'), 'old only')
  const log = path.join(root, 'task.log'); await fs.writeFile(log, '')
  const children = []
  async function tails(count, elsewhere = false) {
    let executable = path.join(installed, runtime, 'tail.exe')
    if (elsewhere) {
      const other = path.join(root, 'other-git')
      await fs.cp(path.join(installed, runtime), other, { recursive: true })
      executable = path.join(other, 'tail.exe')
    }
    const running = Array.from({ length: count }, () => {
      const child = spawn(executable, ['-n', '0', '-f', '-s', '0.1', log], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      child.output = ''; child.stdout.on('data', bytes => { child.output += bytes })
      child.stderr.resume(); children.push(child); return child
    })
    await wait(500)
    for (const child of running) assert.equal(child.exitCode, null, 'tail fixture must actually be running')
    return running
  }
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill()
    await Promise.all(children.map(child => child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : undefined))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const plan = path.join(root, 'files.tsv'), exclusions = path.join(root, 'keep.txt'), archive = path.join(root, 'incoming.7z')
  async function prepare() {
    const entries = []
    async function walk(directory) {
      for (const name of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, name.name)
        if (name.isDirectory()) await walk(file)
        else {
          const relative = path.relative(incoming, file).split(path.sep).join('/')
          entries.push(`${hash(await fs.readFile(file))}\t${relative}\n`)
        }
      }
    }
    await walk(incoming); await fs.writeFile(plan, entries.join(''))
    const packed = spawnSync(decoder, ['a', '-t7z', archive, '.'], { cwd: incoming, windowsHide: true, encoding: 'utf8' })
    assert.equal(packed.status, 0, packed.stdout + packed.stderr)
  }
  function overlay(args = ['--silent']) {
    return spawnSync(helper, [installed, '--prepare-overlay', plan, exclusions, ...args], { windowsHide: true, encoding: 'utf8', timeout: 30_000 })
  }
  async function extract() {
    const decoded = spawnSync(decoder, ['x', '-y', '-spd', '-scsUTF-8', `-x@${exclusions}`, `-o${installed}`, archive], { windowsHide: true, encoding: 'utf8' })
    assert.equal(decoded.status, 0, decoded.stdout + decoded.stderr)
    assert.equal(await fs.readFile(path.join(installed, 'program/gui/Crabot.exe'), 'utf8'), 'new GUI')
    assert.equal(await fs.readFile(path.join(installed, 'program/core/app.js'), 'utf8'), 'new core')
    assert.equal(await fs.readFile(path.join(installed, 'data/keep.txt'), 'utf8'), 'user data')
    await assert.rejects(fs.stat(path.join(installed, 'program/core/obsolete.js')), { code: 'ENOENT' })
  }
  return { root, installed, incoming, runtime, log, tails, prepare, overlay, extract, plan, exclusions }
}

test('same Git upgrades around four running tails; missing files are repaired and output continues', { skip: !windows }, async t => {
  const f = await fixture(t), running = await f.tails(4)
  await fs.rm(path.join(f.installed, f.runtime, 'runtime-version.txt'))
  await f.prepare()
  const result = f.overlay()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  await f.extract()
  assert.equal(await fs.readFile(path.join(f.installed, f.runtime, 'runtime-version.txt'), 'utf8'), 'same Git')
  await fs.appendFile(f.log, 'after upgrade\n'); await wait(1500)
  for (const child of running) {
    assert.equal(child.exitCode, null, 'same tail PID must survive the upgrade')
    assert.match(child.output, /after upgrade/, 'surviving task must keep producing output')
  }
})

test('changed Git stops before touching old programs when silent install lacks shutdown consent', { skip: !windows }, async t => {
  const f = await fixture(t), running = await f.tails(2), unrelated = await f.tails(1, true)
  await fs.writeFile(path.join(f.incoming, f.runtime, 'runtime-version.txt'), 'updated Git')
  await f.prepare()
  const result = f.overlay()
  assert.equal(result.status, 2, result.stdout + result.stderr)
  for (const child of running) assert.match(result.stdout + result.stderr, new RegExp(`\\b${child.pid}\\b`))
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`\\b${unrelated[0].pid}\\b`))
  assert.equal(await fs.readFile(path.join(f.installed, 'program/gui/Crabot.exe'), 'utf8'), 'old GUI')
  assert.equal(await fs.readFile(path.join(f.installed, 'program/core/app.js'), 'utf8'), 'old core')
  assert.equal(await fs.readFile(path.join(f.installed, 'program/core/obsolete.js'), 'utf8'), 'old only')
  for (const child of [...running, ...unrelated]) assert.equal(child.exitCode, null)
})

// Exercise the production MessageBox, rather than adding an unattended force
// flag to the installer. The driver can click only this fixture helper's dialog.
function clickDialog(pid, button) {
  const source = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
public class OverlayDialog {
  public delegate bool Window(IntPtr handle, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Window callback, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, Window callback, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wparam, IntPtr lparam);
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h,d) => { uint owner; GetWindowThreadProcessId(h,out owner); var text=new StringBuilder(1024); GetWindowText(h,text,1024);
      if(owner==pid && text.ToString().Contains("Crabot")) { found=h; return false; } return true; },IntPtr.Zero);
    return found;
  }
  public static string Text(IntPtr dialog) {
    var body=new StringBuilder(); EnumChildWindows(dialog,(h,d) => { var text=new StringBuilder(32768); GetWindowText(h,text,32768); body.AppendLine(text.ToString()); return true; },IntPtr.Zero); return body.ToString();
  }
}`
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${source}\n'@; $until=[DateTime]::UtcNow.AddSeconds(15); $dialog=[IntPtr]::Zero; do { $dialog=[OverlayDialog]::Find(${pid}); if($dialog -ne [IntPtr]::Zero){break}; Start-Sleep -Milliseconds 100 } while([DateTime]::UtcNow -lt $until); if($dialog -eq [IntPtr]::Zero){throw 'Fixture consent dialog not found'}; $body=[OverlayDialog]::Text($dialog); $default=[OverlayDialog]::SendMessage($dialog,1024,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -band 65535; [OverlayDialog]::SendMessage($dialog,273,[IntPtr]${button},[IntPtr]::Zero)|Out-Null; @{body=$body;default_button=$default;clicked=${button}} | ConvertTo-Json -Compress`
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const result = spawnSync(powershell, ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 25_000 })
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error ?? ''))
  return JSON.parse(result.stdout)
}
async function interactiveOverlay(f, button) {
  const child = spawn(helper, [f.installed, '--prepare-overlay', f.plan, f.exclusions], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  try {
    const dialog = clickDialog(child.pid, button)
    const code = await exited
    return { code, dialog, output }
  } finally { if (child.exitCode === null) child.kill() }
}

test('cancelling the runtime consent dialog preserves programs and running tasks', { skip: !windows }, async t => {
  const f = await fixture(t), running = await f.tails(2)
  await fs.writeFile(path.join(f.incoming, f.runtime, 'runtime-version.txt'), 'updated Git')
  await f.prepare()
  const result = await interactiveOverlay(f, 2)
  assert.equal(result.code, 3, result.output)
  for (const child of running) { assert.match(result.dialog.body, new RegExp(`\\b${child.pid}\\b`)); assert.equal(child.exitCode, null) }
  assert.equal(result.dialog.default_button, 2, 'cancellation must be the default')
  assert.equal(await fs.readFile(path.join(f.installed, 'program/gui/Crabot.exe'), 'utf8'), 'old GUI')
  assert.equal(await fs.readFile(path.join(f.installed, f.runtime, 'runtime-version.txt'), 'utf8'), 'same Git')
})

test('explicit consent stops only listed runtime users and then installs the changed files', { skip: !windows }, async t => {
  const f = await fixture(t), running = await f.tails(2), unrelated = await f.tails(1, true)
  await fs.writeFile(path.join(f.incoming, f.runtime, 'runtime-version.txt'), 'updated Git')
  await f.prepare()
  const result = await interactiveOverlay(f, 6)
  assert.equal(result.code, 0, result.output)
  for (const child of running) {
    assert.match(result.dialog.body, new RegExp(`\\b${child.pid}\\b`))
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve))
    assert.notEqual(child.exitCode, null)
  }
  assert.doesNotMatch(result.dialog.body, new RegExp(`\\b${unrelated[0].pid}\\b`))
  assert.equal(unrelated[0].exitCode, null, 'another installation must never inherit shutdown consent')
  await f.extract()
  assert.equal(await fs.readFile(path.join(f.installed, f.runtime, 'runtime-version.txt'), 'utf8'), 'updated Git')
})

test('fresh installation uses an empty preservation list and extracts every runtime file', { skip: !windows }, async t => {
  const f = await fixture(t)
  await fs.rm(path.join(f.installed, 'program'), { recursive: true })
  await f.prepare()
  const result = f.overlay()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(await fs.readFile(f.exclusions, 'utf8'), '')
  await f.extract()
  assert.equal((await fs.stat(path.join(f.installed, f.runtime, 'tail.exe'))).isFile(), true)
})
