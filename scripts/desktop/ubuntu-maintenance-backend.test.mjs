import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildUbuntuMaintenanceBackend } from './ubuntu-maintenance-backend.mjs'
import { desktopMaintenanceNodeFiles } from '../lib/desktop-maintenance-bootstrap.mjs'
const run = promisify(execFile)
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-fixed-node-code-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { root, output: path.join(root, 'backend') }
}
test('the fixed Node backend loads in an independent private Node without Core or external JS packages', { timeout: 30000 }, async t => {
  const f = await fixture(t); await buildUbuntuMaintenanceBackend(f.output)
  const node = path.join(f.root, process.platform === 'win32' ? 'node.exe' : 'node')
  await fs.copyFile(process.execPath, node); if (process.platform !== 'win32') await fs.chmod(node, 0o700)
  await fs.writeFile(path.join(f.root, 'preserved-data'), 'user data')
  const script = `
    import path from 'node:path'; import fs from 'node:fs'; import {pathToFileURL} from 'node:url'; import {createRequire} from 'node:module';
    const output=process.argv[1]; globalThis.fetch=()=>{throw new Error('no network during maintenance module loading')};
    const load=name=>import(pathToFileURL(path.join(output,'bootstrap/scripts/lib',name)).href);
    const proof=await load('desktop-removal-proof.mjs'), job=await load('desktop-removal-job.mjs');
    const progress=await import(pathToFileURL(path.join(output,'progress.mjs')).href);
    const require=createRequire(pathToFileURL(path.join(output,'probe.cjs')));
    const native=require('./bootstrap/scripts/lib/process-identity.cjs'), asar=require('@electron/asar');
    fs.mkdirSync(path.join(output,'sample'));fs.writeFileSync(path.join(output,'sample/value'),'archive probe');
    await asar.createPackage(path.join(output,'sample'),path.join(output,'probe.asar'));
    if(asar.extractFile(path.join(output,'probe.asar'),'value').toString()!=='archive probe')throw new Error('bundled archive reader failed');
    if(typeof proof.readDesktopRemovalProof!=='function'||typeof job.beginInitialDesktopRemoval!=='function'||typeof progress.createUbuntuRemovalProgressWindow!=='function'||native.inspectProcess(process.pid).pid!==process.pid)throw new Error('fixed backend incomplete');
    if(fs.readFileSync('preserved-data','utf8')!=='user data')throw new Error('data changed');
    console.log(JSON.stringify({fixed_node_backend_loaded:true,actual_private_node:true,native_addon_loaded:true,actual_archive_reader:true,core_present:false,business_mm_started:false}));
  `
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : [])); env.PATH = ''
  const result = await run(node, ['--input-type=module', '--eval', script, f.output], { cwd: f.root, env, timeout: 20000, maxBuffer: 65536 })
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report, { fixed_node_backend_loaded: true, actual_private_node: true, native_addon_loaded: true, actual_archive_reader: true, core_present: false, business_mm_started: false })
  assert.equal(await fs.readFile(path.join(f.root, 'preserved-data'), 'utf8'), 'user data')
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['backend', path.basename(node), 'preserved-data'].sort())
  console.log('CRABOT_PRIVATE_NODE_BACKEND '+JSON.stringify(report))
})
test('the generated backend contains only the shared fixed code list', { timeout: 30000 }, async t => {
  const f = await fixture(t); await buildUbuntuMaintenanceBackend(f.output)
  const names=[]
  async function walk(directory) { for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name); if(entry.isDirectory())await walk(file);else {assert.ok(entry.isFile());names.push(path.relative(f.output,file).split(path.sep).join('/'))}} }
  await walk(f.output);assert.deepEqual(names.sort(),[...desktopMaintenanceNodeFiles].sort())
  assert.equal(names.some(name => /(^|\/)(data|core|\.product-runtime)(\/|$)/.test(name)),false)
})
test('an existing output is retained rather than recursively replaced', async t => {
  const f = await fixture(t); await fs.mkdir(f.output); await fs.writeFile(path.join(f.output, 'keep'), 'existing material')
  await assert.rejects(buildUbuntuMaintenanceBackend(f.output), { code: 'EEXIST' })
  assert.equal(await fs.readFile(path.join(f.output, 'keep'), 'utf8'), 'existing material')
})
