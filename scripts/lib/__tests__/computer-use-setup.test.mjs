import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
const require = createRequire(import.meta.url)
const { pin } = require('../computer-use-runtime.cjs')
const helper = require('../computer-use-setup.cjs')
const mac = { skip: process.platform !== 'darwin' }

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cu-helper-fixture-'))
  const bin = path.join(root, 'bin'); await fs.mkdir(bin)
  const runtime = path.join(root, '.computer-use-runtime', `${pin.version}-${process.platform}-${process.arch}`)
  const app = path.join(runtime, 'CuaDriver.app/Contents/MacOS/cua-driver')
  await fs.mkdir(path.dirname(app), { recursive: true })
  const control = path.join(root, 'control.json')
  await fs.writeFile(control, JSON.stringify({ accessibility: true, screen_recording: false }))
  const program = `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2),config=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
fs.appendFileSync(${JSON.stringify(path.join(root, 'calls.jsonl'))},JSON.stringify({pid:process.pid,args})+'\\n');
setTimeout(()=>{
  if(args.includes('--cua-internal-permission-probe'))process.stdout.write(JSON.stringify({accessibility:config.accessibility,screen_recording:config.screen_recording}));
  else fs.writeFileSync(args[args.indexOf('--result-file')+1],JSON.stringify({content:[],structuredContent:{accessibility:config.accessibility,screen_recording:config.screen_recording,screen_recording_capturable:config.capture===true,direct_capture_status:config.capture?'ready':'unavailable',source:{attribution:config.badIdentity?'launching-app':'driver-daemon',bundle_id:'com.trycua.driver',executable:fs.realpathSync(${JSON.stringify(app)})}}}));
},config.delay||0);
`
  await fs.writeFile(app, program, { mode: 0o755 })
  await fs.writeFile(path.join(runtime, 'cua-driver'), 'fixture')
  const files = { 'cua-driver': crypto.createHash('sha256').update('fixture').digest('hex'),
    'CuaDriver.app/Contents/MacOS/cua-driver': crypto.createHash('sha256').update(program).digest('hex'),
    'CuaDriver.app/Contents/Info.plist': 'fixture', 'CuaDriver.app/Contents/_CodeSignature/CodeResources': 'fixture' }
  await fs.writeFile(path.join(runtime, 'ready.json'), JSON.stringify({ version: pin.version, sha256: pin.assets[`${process.platform}-${process.arch}`].sha256, files }))
  await fs.writeFile(path.join(bin, 'codesign'), `#!${process.execPath}\nprocess.exit(0)`, { mode: 0o755 })
  await fs.writeFile(path.join(bin, 'open'), `#!${process.execPath}
const fs=require('node:fs'),{spawn}=require('node:child_process'),path=require('node:path');
const a=process.argv.slice(2),at=a.indexOf('--args');
const stdout=a.includes('--stdout')?fs.openSync(a[a.indexOf('--stdout')+1],'w'):fs.openSync('/dev/null','w');
const stderr=fs.openSync(a[a.indexOf('--stderr')+1],'w');
spawn(process.execPath,[path.join(a[at-1],'Contents/MacOS/cua-driver'),...a.slice(at+1)],{stdio:['ignore',stdout,stderr],detached:true}).unref();
`, { mode: 0o755 })
  const original = process.env.PATH
  const originalTmp = process.env.TMPDIR
  const privateTmp = path.join(root, 'tmp'); await fs.mkdir(privateTmp)
  process.env.PATH = bin + path.delimiter + original
  process.env.TMPDIR = privateTmp
  return { root, app, control, privateTmp, close: async () => {
    process.env.PATH = original
    if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp
    await fs.rm(root, { recursive: true, force: true })
  } }
}

test('finite signed-App probe reports the individual flags; prompting is explicit and identity checked', mac, async () => {
  const f = await fixture()
  try {
    assert.deepEqual(await helper.readPermissions(f.root), { accessibility: true, screen_recording: false })
    const calls = (await fs.readFile(path.join(f.root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.length, 1)
    assert.ok(calls[0].args.includes('--cua-internal-permission-probe'))
    assert.ok(!calls[0].args.includes('serve'))
    await fs.writeFile(f.control, JSON.stringify({ accessibility: true, screen_recording: true, capture: true }))
    assert.equal((await helper.requestPermissions(f.root, { probeCapture: true })).capturable, true)
    await fs.writeFile(f.control, JSON.stringify({ accessibility: true, screen_recording: true, capture: true, badIdentity: true }))
    await assert.rejects(helper.requestPermissions(f.root, { probeCapture: true }), /COMPUTER_USE_HELPER_IDENTITY_INVALID/)
    await assert.rejects(fs.stat(path.join(os.tmpdir(), `crabot-cua-permission-helper-${process.getuid()}.lock`)), { code: 'ENOENT' })
  } finally { await f.close() }
})
test('missing runtime is diagnosed without launching an App or disclosing filesystem errors', mac, async () => {
  const f = await fixture()
  try {
    await fs.unlink(path.join(path.dirname(path.dirname(path.dirname(path.dirname(f.app)))), 'ready.json'))
    await assert.rejects(helper.readPermissions(f.root), { message: 'COMPUTER_USE_RUNTIME_MISSING' })
    await assert.rejects(fs.stat(path.join(f.root, 'calls.jsonl')), { code: 'ENOENT' })
    assert.deepEqual(await fs.readdir(f.privateTmp), [])
  } finally { await f.close() }
})
test('cancel closes only the exact owned helper; unrelated driver-like process survives', mac, async () => {
  const f = await fixture()
  const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', f.app, '--result-file', '/tmp/foreign-driver-result'], { stdio: 'ignore' })
  try {
    await fs.writeFile(f.control, JSON.stringify({ accessibility: true, screen_recording: true, delay: 10000 }))
    const controller = new AbortController()
    const active = helper.readPermissions(f.root, { signal: controller.signal })
    const rejected = assert.rejects(active, /COMPUTER_USE_(SETUP_CANCELLED|HELPER_LAUNCH_FAILED)/)
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !await fs.stat(path.join(f.root, 'calls.jsonl')).then(() => true, () => false)) await new Promise(done => setTimeout(done, 25))
    assert.ok(await fs.stat(path.join(f.root, 'calls.jsonl')).then(() => true, () => false), 'the owned helper must actually have started')
    controller.abort(); await rejected
    assert.doesNotThrow(() => process.kill(foreign.pid, 0))
    await assert.rejects(fs.stat(path.join(os.tmpdir(), `crabot-cua-permission-helper-${process.getuid()}.lock`)), { code: 'ENOENT' })
  } finally { foreign.kill(); await new Promise(done => foreign.once('exit', done)); await f.close() }
})
test('concurrent read probes serialize and remove their private resources', mac, async () => {
  const f = await fixture()
  try {
    await fs.writeFile(f.control, JSON.stringify({ accessibility: true, screen_recording: true, delay: 150 }))
    const values = await Promise.all([helper.readPermissions(f.root), helper.readPermissions(f.root)])
    assert.ok(values.every(value => value.accessibility && value.screen_recording))
    assert.equal((await fs.readFile(path.join(f.root, 'calls.jsonl'), 'utf8')).trim().split('\n').length, 2)
    assert.deepEqual(await fs.readdir(f.privateTmp), [])
  } finally { await f.close() }
})
test('a new owner confirms an orphaned finite helper exits before taking the resource guard', mac, async () => {
  const f = await fixture()
  let orphan
  try {
    await fs.writeFile(f.control, JSON.stringify({ accessibility: true, screen_recording: true, delay: 10000 }))
    const marker = path.join(f.privateTmp, `cua-driver-permissions-crabot-1-${crypto.randomUUID()}.json`)
    await fs.writeFile(marker, '', { mode: 0o600 })
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    await new Promise(done => dead.once('exit', done))
    orphan = spawn(process.execPath, [f.app, '--cua-internal-permission-probe', '--result-file', marker], { stdio: 'ignore' })
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !await fs.stat(path.join(f.root, 'calls.jsonl')).then(() => true, () => false)) await new Promise(done => setTimeout(done, 25))
    assert.ok(await fs.stat(path.join(f.root, 'calls.jsonl')).then(() => true, () => false))
    const lock = path.join(f.privateTmp, `crabot-cua-permission-helper-${process.getuid()}.lock`)
    await fs.mkdir(lock, { mode: 0o700 })
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ owner_pid: dead.pid, app: path.dirname(path.dirname(path.dirname(f.app))), marker }), { mode: 0o600 })
    await fs.writeFile(f.control, JSON.stringify({ accessibility: true, screen_recording: true }))
    assert.deepEqual(await helper.readPermissions(f.root), { accessibility: true, screen_recording: true })
    assert.ok(orphan.exitCode !== null || orphan.signalCode !== null)
    assert.deepEqual(await fs.readdir(f.privateTmp), [])
  } finally {
    if (orphan && orphan.exitCode === null && orphan.signalCode === null) { orphan.kill(); await new Promise(done => orphan.once('exit', done)) }
    await f.close()
  }
})
